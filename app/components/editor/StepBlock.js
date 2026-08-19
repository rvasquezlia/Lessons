/**
 * TipTap custom extension: Step-by-Step explanation block
 *
 * Renders numbered steps with optional hint text per step.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent } from "@tiptap/react";

function StepBlockView({ node, updateAttributes }) {
  const stepNumber = node.attrs.step ?? 1;
  const hint = node.attrs.hint ?? "";

  return (
    <NodeViewWrapper
      className="tiptap-step"
      data-type="stepBlock"
      data-step={stepNumber}
    >
      <div className="tiptap-step__header">
        <span className="tiptap-step__number">Step {stepNumber}</span>
        <input
          className="tiptap-step__hint-input"
          placeholder="Optional hint…"
          value={hint}
          onChange={(e) => updateAttributes({ hint: e.target.value })}
        />
      </div>
      <div className="tiptap-step__body">
        <NodeViewContent />
      </div>
    </NodeViewWrapper>
  );
}

export const StepBlock = Node.create({
  name: "stepBlock",
  group: "block",
  content: "block+",
  draggable: true,

  addAttributes() {
    return {
      step: { default: 1 },
      hint: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="stepBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "stepBlock" }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(StepBlockView);
  },
});
