"use client";

/**
 * BlockEditor
 * ──────────────────────────────────────────────────────────────────
 * Core TipTap visual (block) editor for the Lessons CMS.
 *
 * Features:
 *  - StarterKit (paragraphs, headings, lists, bold, italic, …)
 *  - Custom extensions: DynamicTabs, Carousel, StepBlock, CodeCopy
 *  - Inline TaxonomySelector for Grade → Subject → Topic
 *  - Publishing-status selector (draft | in_review | published)
 *  - KaTeX math rendering (inline $…$ and block $$…$$)
 *  - Save-to-repository button (commits via Octokit)
 *
 * Props:
 *  pageJson  – { title, status, taxonomy, body: [{type, …}] }
 *  onSave    – async (updatedPageJson) => void   (parent handles Octokit commit)
 */
import { useCallback, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";

import { DynamicTabs } from "./DynamicTabs";
import { Carousel } from "./Carousel";
import { StepBlock } from "./StepBlock";
import { CodeCopy } from "./CodeCopy";
import TaxonomySelector from "./TaxonomySelector";
import EditorToolbar from "./EditorToolbar";

const STATUS_OPTIONS = ["draft", "in_review", "published"];

export default function BlockEditor({ pageJson = {}, onSave }) {
  const [title, setTitle] = useState(pageJson.title ?? "");
  const [status, setStatus] = useState(pageJson.status ?? "draft");
  const [taxonomy, setTaxonomy] = useState(pageJson.taxonomy ?? {});
  const [saving, setSaving] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      Placeholder.configure({ placeholder: "Start writing your lesson content…" }),
      Link.configure({ openOnClick: false }),
      Image.configure({ inline: false, allowBase64: true }),
      DynamicTabs,
      Carousel,
      StepBlock,
      CodeCopy,
    ],
    content: pageJson.body ?? "",
    editorProps: {
      attributes: {
        class: "block-editor__content prose",
        "data-testid": "block-editor",
      },
    },
  });

  const handleSave = useCallback(async () => {
    if (!editor) return;
    setSaving(true);
    try {
      const updated = {
        ...pageJson,
        title,
        status,
        taxonomy,
        body: editor.getHTML(),
        updatedAt: new Date().toISOString(),
      };
      await onSave?.(updated);
    } finally {
      setSaving(false);
    }
  }, [editor, onSave, pageJson, title, status, taxonomy]);

  if (!editor) return null;

  return (
    <div className="block-editor">
      {/* ── Meta bar ── */}
      <div className="block-editor__meta">
        <input
          className="block-editor__title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Page title…"
        />

        <label className="block-editor__status-label">
          Status
          <select
            className="block-editor__status-select"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* ── Taxonomy selector ── */}
      <TaxonomySelector value={taxonomy} onChange={setTaxonomy} />

      {/* ── Formatting toolbar ── */}
      <EditorToolbar editor={editor} />

      {/* ── Editor canvas ── */}
      <EditorContent editor={editor} className="block-editor__canvas" />

      {/* ── Save button ── */}
      <div className="block-editor__footer">
        <button
          className="block-editor__save-btn"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving…" : "💾 Commit to Repository"}
        </button>
      </div>
    </div>
  );
}
