/**
 * TipTap custom extension: Dynamic Tabs
 *
 * Usage in editor: Insert a tabbed content block where each tab has
 * a label and a body. Renders as a structured node with children.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { useState } from "react";
import { NodeViewWrapper, NodeViewContent } from "@tiptap/react";

// ──────────────────────────────────────────
// Node View (React component rendered inside the editor)
// ──────────────────────────────────────────
function DynamicTabsView({ node, updateAttributes }) {
  const tabs = node.attrs.tabs ?? [{ label: "Tab 1" }, { label: "Tab 2" }];
  const [activeIdx, setActiveIdx] = useState(0);

  return (
    <NodeViewWrapper className="tiptap-tabs" data-type="dynamicTabs">
      <div className="tiptap-tabs__bar">
        {tabs.map((tab, i) => (
          <button
            key={i}
            className={`tiptap-tabs__tab${i === activeIdx ? " tiptap-tabs__tab--active" : ""}`}
            onClick={() => setActiveIdx(i)}
          >
            {tab.label}
          </button>
        ))}
        <button
          className="tiptap-tabs__add"
          onClick={() =>
            updateAttributes({
              tabs: [...tabs, { label: `Tab ${tabs.length + 1}` }],
            })
          }
        >
          + Tab
        </button>
      </div>
      <div className="tiptap-tabs__panel">
        <NodeViewContent data-tab-index={activeIdx} />
      </div>
    </NodeViewWrapper>
  );
}

export const DynamicTabs = Node.create({
  name: "dynamicTabs",
  group: "block",
  content: "block+",
  draggable: true,

  addAttributes() {
    return {
      tabs: {
        default: [{ label: "Tab 1" }, { label: "Tab 2" }],
        parseHTML: (el) => JSON.parse(el.getAttribute("data-tabs") ?? "[]"),
        renderHTML: (attrs) => ({ "data-tabs": JSON.stringify(attrs.tabs) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="dynamicTabs"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "dynamicTabs" }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DynamicTabsView);
  },
});
