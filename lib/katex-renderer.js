/**
 * lib/katex-renderer.js
 * ─────────────────────
 * Build-time KaTeX utilities.
 *
 * Parses inline ($...$) and block ($$...$$) math expressions in an HTML
 * string and replaces them with pre-rendered KaTeX HTML so the static
 * export requires zero client-side math rendering.
 *
 * Usage:
 *   import { renderMathInHtml } from "@/lib/katex-renderer";
 *   const html = renderMathInHtml(rawHtml);
 */

import katex from "katex";

const BLOCK_MATH_RE = /\$\$([\s\S]+?)\$\$/g;
const INLINE_MATH_RE = /\$([^$\n]+?)\$/g;

/**
 * Render all LaTeX math in an HTML string.
 * Block math ($$...$$) is rendered as display mode.
 * Inline math ($...$) is rendered as inline mode.
 *
 * @param {string} html  Raw HTML that may contain LaTeX delimiters
 * @returns {string}     HTML with KaTeX-rendered math spans
 */
export function renderMathInHtml(html) {
  if (!html) return html;

  // 1. Replace block math first (must come before inline to avoid partial matches)
  let result = html.replace(BLOCK_MATH_RE, (_match, tex) => {
    try {
      return katex.renderToString(tex.trim(), {
        displayMode: true,
        throwOnError: false,
        output: "html",
      });
    } catch {
      return _match; // leave untouched on error
    }
  });

  // 2. Replace inline math
  result = result.replace(INLINE_MATH_RE, (_match, tex) => {
    try {
      return katex.renderToString(tex.trim(), {
        displayMode: false,
        throwOnError: false,
        output: "html",
      });
    } catch {
      return _match;
    }
  });

  return result;
}

/**
 * Auto-repair common broken LaTeX escape strings produced by legacy
 * HTML copy-paste (e.g. `\\frac` should be `\frac`).
 *
 * @param {string} tex  LaTeX source string
 * @returns {string}    Repaired LaTeX source
 */
export function repairLatex(tex) {
  if (!tex) return tex;
  // Convert double-backslash escapes to single
  return tex.replace(/\\{2}([a-zA-Z{}\[\]()^_])/g, "\\$1");
}
