/**
 * TipTap custom extension: UI Carousel
 *
 * Embeds a slide-by-slide carousel inside the document.
 * Each slide is a block-level child node.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent } from "@tiptap/react";
import { useState } from "react";

function CarouselView({ node, updateAttributes }) {
  const slideCount = node.attrs.slideCount ?? 1;
  const [current, setCurrent] = useState(0);

  return (
    <NodeViewWrapper className="tiptap-carousel" data-type="carousel">
      <div className="tiptap-carousel__viewport">
        <NodeViewContent data-slide={current} />
      </div>
      <div className="tiptap-carousel__controls">
        <button
          className="tiptap-carousel__btn"
          onClick={() => setCurrent((c) => Math.max(0, c - 1))}
          disabled={current === 0}
        >
          ‹ Prev
        </button>
        <span className="tiptap-carousel__counter">
          {current + 1} / {slideCount}
        </span>
        <button
          className="tiptap-carousel__btn"
          onClick={() => setCurrent((c) => Math.min(slideCount - 1, c + 1))}
          disabled={current === slideCount - 1}
        >
          Next ›
        </button>
        <button
          className="tiptap-carousel__add"
          onClick={() => updateAttributes({ slideCount: slideCount + 1 })}
        >
          + Slide
        </button>
      </div>
    </NodeViewWrapper>
  );
}

export const Carousel = Node.create({
  name: "carousel",
  group: "block",
  content: "block+",
  draggable: true,

  addAttributes() {
    return {
      slideCount: { default: 1 },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="carousel"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "carousel" }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CarouselView);
  },
});
