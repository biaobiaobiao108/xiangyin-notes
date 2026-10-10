import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { escapeImageAlt, isExternalImageSource, parseImageSource, serializeImageSource } from "../image-markdown";

type ImageNodeAttrs = {
  assetId: string | null;
  src: string;
  alt: string;
  title: string | null;
  width: number | null;
  height: number | null;
};

const MIN_IMAGE_WIDTH = 120;

function imageDimensions(node: NodeViewProps["node"]) {
  const attrs = node.attrs as ImageNodeAttrs;
  const width = Number.isFinite(Number(attrs.width)) && Number(attrs.width) > 0 ? Number(attrs.width) : 640;
  const height = Number.isFinite(Number(attrs.height)) && Number(attrs.height) > 0 ? Number(attrs.height) : Math.round(width * 0.75);
  return { width, height };
}

function ResizableImageView({ node, selected, editor, updateAttributes }: NodeViewProps) {
  const attrs = node.attrs as ImageNodeAttrs;
  const source = parseImageSource(attrs.src);
  const [loadedExternalSource, setLoadedExternalSource] = useState<string | null>(null);
  const isExternal = !attrs.assetId && isExternalImageSource(source.src);
  const imageSource = isExternal ? (loadedExternalSource === source.src ? source.src : null) : source.src;
  const { width, height } = imageDimensions(node);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number; ratio: number; currentWidth: number; maxWidth: number; animationFrame: number | null; pointerId: number } | null>(null);

  const setFrameWidth = (nextWidth: number) => {
    frameRef.current?.style.setProperty("--image-display-width", `${Math.round(nextWidth)}px`);
  };

  const finishResize = (cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.animationFrame !== null) cancelAnimationFrame(drag.animationFrame);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    if (cancelled) setFrameWidth(width);
    else updateAttributes({ width: Math.round(drag.currentWidth), height: Math.round(drag.currentWidth * drag.ratio) });
    dragRef.current = null;
  };

  const onPointerMove = (event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const nextWidth = Math.min(drag.maxWidth, Math.max(Math.min(MIN_IMAGE_WIDTH, drag.maxWidth), drag.startWidth + event.clientX - drag.startX));
    drag.currentWidth = nextWidth;
    if (drag.animationFrame !== null) return;
    drag.animationFrame = requestAnimationFrame(() => {
      drag.animationFrame = null;
      setFrameWidth(drag.currentWidth);
    });
  };
  const onPointerUp = (event: PointerEvent) => {
    if (dragRef.current?.pointerId === event.pointerId) finishResize(false);
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (dragRef.current?.pointerId === event.pointerId) finishResize(true);
  };

  useEffect(() => () => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.animationFrame !== null) cancelAnimationFrame(drag.animationFrame);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!editor.isEditable) return;
    event.preventDefault();
    event.stopPropagation();
    const maxWidth = Math.max(1, frameRef.current?.closest(".note-prose")?.getBoundingClientRect().width ?? 820);
    const ratio = height / Math.max(1, width);
    dragRef.current = { startX: event.clientX, startWidth: width, ratio, currentWidth: width, maxWidth, animationFrame: null, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  const adjustByKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    // 输入法候选态下的 Escape 只取消候选，不得触发缩放退出。
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (!editor.isEditable || !["ArrowLeft", "ArrowRight", "Escape"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      finishResize(true);
      return;
    }
    const maxWidth = Math.max(1, frameRef.current?.closest(".note-prose")?.getBoundingClientRect().width ?? 820);
    const nextWidth = Math.min(maxWidth, Math.max(Math.min(MIN_IMAGE_WIDTH, maxWidth), width + (event.key === "ArrowRight" ? 16 : -16)));
    updateAttributes({ width: Math.round(nextWidth), height: Math.round(nextWidth * (height / Math.max(1, width))) });
  };

  const frameStyle = { "--image-display-width": `${Math.round(width)}px` } as CSSProperties;
  return <NodeViewWrapper className={`note-image-node ${selected ? "is-selected" : ""}`}>
    <span ref={frameRef} className="note-image-frame" style={frameStyle}>
      {imageSource ? (
        <img className="note-image" src={imageSource} alt={attrs.alt} width={Math.round(width)} height={Math.round(height)} draggable={false} decoding="async" loading={isExternal ? "lazy" : editor.isEditable ? "eager" : "lazy"} />
      ) : (
        <span className="note-image-loading" role="group" style={{ aspectRatio: `${Math.round(width)} / ${Math.round(height)}` }}>
          <span>外链图片不会自动加载</span>
          <span>点击后会向图片所在网站发起请求</span>
          <button
            className="secondary-button"
            type="button"
            aria-label="加载外链图片；加载后会向图片所在网站发起请求"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setLoadedExternalSource(source.src);
            }}
          >加载外链图片</button>
        </span>
      )}
      {imageSource && editor.isEditable && selected && <button className="note-image-resize-handle" type="button" aria-label="调整图片大小" onPointerDown={startResize} onKeyDown={adjustByKeyboard} />}
    </span>
  </NodeViewWrapper>;
}

export const ImageNode = Node.create({
  name: "image",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  inline: false,
  markdownTokenName: "image",

  addAttributes() {
    return {
      assetId: { default: null },
      src: { default: "" },
      alt: { default: "" },
      title: { default: null },
      width: { default: null },
      height: { default: null },
    };
  },

  parseHTML() {
    return [{
      tag: "img[src]",
      getAttrs: (element) => {
        const image = element as HTMLImageElement;
        const parsed = parseImageSource(image.getAttribute("src") ?? "");
        const width = parsed.width ?? Number(image.getAttribute("width"));
        const height = parsed.height ?? Number(image.getAttribute("height"));
        return { src: parsed.src, alt: image.getAttribute("alt") ?? "", title: image.getAttribute("title"), width: Number.isFinite(width) && width > 0 ? width : null, height: Number.isFinite(height) && height > 0 ? height : null };
      },
    }];
  },

  renderHTML({ HTMLAttributes }) {
    const parsed = parseImageSource(String(HTMLAttributes.src ?? ""));
    const { title: _title, ...renderedAttributes } = HTMLAttributes;
    return ["img", mergeAttributes(renderedAttributes, { src: parsed.src, alt: HTMLAttributes.alt ?? "", width: parsed.width ?? HTMLAttributes.width ?? undefined, height: parsed.height ?? HTMLAttributes.height ?? undefined, decoding: "async", loading: "lazy" })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageView);
  },

  parseMarkdown(token, helpers) {
    const imageToken = token as unknown as { href?: string; url?: string; text?: string; title?: string | null };
    const parsed = parseImageSource(imageToken.href ?? imageToken.url ?? "");
    return helpers.createNode("image", { src: parsed.src, alt: imageToken.text ?? "", title: imageToken.title ?? null, width: parsed.width, height: parsed.height });
  },

  renderMarkdown(node) {
    const attrs = (node.attrs ?? {}) as Partial<ImageNodeAttrs>;
    const title = attrs.title ? ` "${String(attrs.title).replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"")}"` : "";
    return `![${escapeImageAlt(attrs.alt ?? "")}](${serializeImageSource(String(attrs.src ?? ""), attrs.width, attrs.height)}${title})`;
  },
});
