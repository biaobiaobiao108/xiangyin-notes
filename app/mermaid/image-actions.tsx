import type { RefObject } from "react";
import { Code2 } from "lucide-react";
import type { ContextMenuItem } from "../context-menu";
import {
  imageCopyGeometry,
  imagePngBlob,
  useImageActions,
  writeImageClipboard,
} from "../image-actions";

const COPY_PADDING = 16;
const COPY_SCALE = 2;

export function diagramCopyGeometry(width: number, height: number) {
  return imageCopyGeometry(width, height, { padding: COPY_PADDING, scale: COPY_SCALE });
}

async function diagramPngBlob(image: HTMLImageElement, scale = COPY_SCALE) {
  const preview = image.closest<HTMLElement>(".mermaid-preview");
  return imagePngBlob(image, {
    padding: COPY_PADDING,
    scale,
    background: preview ? getComputedStyle(preview).backgroundColor : null,
  });
}

export function copyDiagramImage(image: HTMLImageElement) {
  return writeImageClipboard(() => diagramPngBlob(image));
}

async function prepareDiagramViewer(image: HTMLImageElement) {
  const scale = Math.min(3, Math.max(COPY_SCALE, window.devicePixelRatio || COPY_SCALE));
  const blob = await diagramPngBlob(image, scale);
  const url = URL.createObjectURL(blob);
  const sourceWidth = image.naturalWidth || Number(image.getAttribute("width")) || 1;
  const sourceHeight = image.naturalHeight || Number(image.getAttribute("height")) || 1;
  return {
    src: url,
    width: sourceWidth + COPY_PADDING * 2,
    height: sourceHeight + COPY_PADDING * 2,
    revoke: () => URL.revokeObjectURL(url),
  };
}

function renderedDiagramImage(root: HTMLElement, target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const rendered = target.closest(".mermaid-rendered");
  if (!rendered || !root.contains(rendered)) return null;
  const image = rendered.querySelector<HTMLImageElement>(".mermaid-preview img.mermaid-image");
  return image?.src && image.naturalWidth > 0 ? image : null;
}

export function buildMermaidExtraMenuItems(onEditSource?: () => void): ContextMenuItem[] {
  return onEditSource
    ? [{ label: "编辑源码", icon: Code2, separator: true, onSelect: onEditSource }]
    : [];
}

export function useMermaidImageActions(
  rootRef: RefObject<HTMLElement | null>,
  { onEditSource }: { onEditSource?: () => void } = {},
) {
  return useImageActions({
    rootRef,
    menuLabel: "图表",
    copyLabel: "复制为图片",
    fallbackAlt: "Mermaid 图表",
    resolveImage: renderedDiagramImage,
    copyImage: copyDiagramImage,
    prepareViewer: prepareDiagramViewer,
    focusTarget: (root) => root.querySelector<HTMLElement>(".mermaid-edit-trigger"),
    extraItems: buildMermaidExtraMenuItems(onEditSource),
  });
}
