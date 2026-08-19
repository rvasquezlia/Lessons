"use client";

/**
 * EditorToolbar
 * ─────────────
 * Formatting toolbar for the TipTap BlockEditor.
 * Renders buttons for common marks, headings, lists, and custom blocks.
 */

export default function EditorToolbar({ editor }) {
  if (!editor) return null;

  const btn = (label, action, isActive = false, title = label) => (
    <button
      key={label}
      className={`editor-toolbar__btn${isActive ? " editor-toolbar__btn--active" : ""}`}
      onClick={action}
      title={title}
      type="button"
    >
      {label}
    </button>
  );

  const insertBlock = (name, attrs = {}) =>
    editor.chain().focus().insertContent({ type: name, attrs }).run();

  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Formatting options">
      {/* Marks */}
      {btn("B", () => editor.chain().focus().toggleBold().run(), editor.isActive("bold"), "Bold")}
      {btn("I", () => editor.chain().focus().toggleItalic().run(), editor.isActive("italic"), "Italic")}
      {btn("S̶", () => editor.chain().focus().toggleStrike().run(), editor.isActive("strike"), "Strike")}
      {btn("<>", () => editor.chain().focus().toggleCode().run(), editor.isActive("code"), "Inline code")}

      <span className="editor-toolbar__sep" />

      {/* Headings */}
      {[1, 2, 3].map((level) =>
        btn(
          `H${level}`,
          () => editor.chain().focus().toggleHeading({ level }).run(),
          editor.isActive("heading", { level }),
          `Heading ${level}`,
        ),
      )}

      <span className="editor-toolbar__sep" />

      {/* Lists */}
      {btn("• List", () => editor.chain().focus().toggleBulletList().run(), editor.isActive("bulletList"))}
      {btn("1. List", () => editor.chain().focus().toggleOrderedList().run(), editor.isActive("orderedList"))}
      {btn("❝", () => editor.chain().focus().toggleBlockquote().run(), editor.isActive("blockquote"), "Blockquote")}
      {btn("HR", () => editor.chain().focus().setHorizontalRule().run(), false, "Horizontal rule")}

      <span className="editor-toolbar__sep" />

      {/* Custom blocks */}
      {btn("Tabs", () => insertBlock("dynamicTabs"), false, "Insert Dynamic Tabs")}
      {btn("Carousel", () => insertBlock("carousel"), false, "Insert Carousel")}
      {btn("Steps", () => insertBlock("stepBlock", { step: 1 }), false, "Insert Step Block")}
      {btn("Code+Copy", () => insertBlock("codeCopy", { language: "text" }), false, "Insert Code-Copy block")}

      <span className="editor-toolbar__sep" />

      {/* Undo / Redo */}
      {btn("↩", () => editor.chain().focus().undo().run(), false, "Undo")}
      {btn("↪", () => editor.chain().focus().redo().run(), false, "Redo")}
    </div>
  );
}
