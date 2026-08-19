/**
 * TipTap custom extension: Code-Copy block
 *
 * A fenced code block that adds a "Copy" button in the rendered output.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import { useState } from "react";

function CodeCopyView({ node }) {
  const [copied, setCopied] = useState(false);
  const code = node.textContent ?? "";

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <NodeViewWrapper className="tiptap-code-copy" data-type="codeCopy">
      <div className="tiptap-code-copy__header">
        <span className="tiptap-code-copy__lang">{node.attrs.language ?? "text"}</span>
        <button className="tiptap-code-copy__btn" onClick={handleCopy}>
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <pre className="tiptap-code-copy__pre">
        <code>{code}</code>
      </pre>
    </NodeViewWrapper>
  );
}

export const CodeCopy = Node.create({
  name: "codeCopy",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  draggable: true,
  defining: true,

  addAttributes() {
    return {
      language: { default: "text" },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="codeCopy"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "codeCopy" }),
      ["pre", ["code", 0]],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeCopyView);
  },
});
