import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { Copy, Maximize2 } from "lucide-react";
import { dispatchKeyboardContextMenu, useContextMenu, type ContextMenuItem } from "./context-menu";
import { ImageLightbox, type ImageViewerState } from "./image-lightbox";

const MAX_COPY_SIDE = 4096;
const MAX_COPY_PIXELS = 16_000_000;

export type ClipboardItemConstructor = {
  new (data: Record<string, Blob | Promise<Blob>>): ClipboardItem;
  supports?: (type: string) => boolean;
};

type ImageCopyOptions = {
  padding?: number;
  scale?: number;
  background?: string | null;
};

export function imageCopyGeometry(
  width: number,
  height: number,
  { padding = 0, scale = 1 }: Pick<ImageCopyOptions, "padding" | "scale"> = {},
) {
  const sourceWidth = Math.max(1, Number.isFinite(width) ? width : 1) + padding * 2;
  const sourceHeight = Math.max(1, Number.isFinite(height) ? height : 1) + padding * 2;
  const appliedScale = Math.min(
    scale,
    MAX_COPY_SIDE / sourceWidth,
    MAX_COPY_SIDE / sourceHeight,
    Math.sqrt(MAX_COPY_PIXELS / (sourceWidth * sourceHeight)),
  );
  return {
    width: Math.max(1, Math.floor(sourceWidth * appliedScale)),
    height: Math.max(1, Math.floor(sourceHeight * appliedScale)),
    padding: Math.max(0, Math.round(padding * appliedScale)),
    scale: appliedScale,
  };
}

export function buildImageMenuItems(
  copyLabel: string,
  actions: {
    copy: () => void | Promise<void>;
    expand: () => void;
  },
  extraItems: ContextMenuItem[] = [],
): ContextMenuItem[] {
  return [
    { label: copyLabel, icon: Copy, onSelect: actions.copy },
    { label: "展开显示", icon: Maximize2, onSelect: actions.expand },
    ...extraItems,
  ];
}

export async function imagePngBlob(
  image: HTMLImageElement,
  { padding = 0, scale = 1, background = null }: ImageCopyOptions = {},
) {
  if (!image.isConnected) throw new Error("图片已更新，请重试。");
  await image.decode();
  const sourceWidth = image.naturalWidth || Number(image.getAttribute("width"));
  const sourceHeight = image.naturalHeight || Number(image.getAttribute("height"));
  const geometry = imageCopyGeometry(sourceWidth, sourceHeight, { padding, scale });
  const canvas = document.createElement("canvas");
  canvas.width = geometry.width;
  canvas.height = geometry.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("图片生成失败，请重试。");
    if (background) {
      context.fillStyle = background;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(
      image,
      geometry.padding,
      geometry.padding,
      Math.round(sourceWidth * geometry.scale),
      Math.round(sourceHeight * geometry.scale),
    );
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error("图片生成失败，请重试。"))),
        "image/png",
      );
    });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function writeImageClipboard(
  createPng: () => Promise<Blob>,
  {
    clipboard = typeof navigator === "undefined" ? null : (navigator.clipboard ?? null),
    ClipboardItemType = typeof ClipboardItem === "undefined"
      ? null
      : (ClipboardItem as unknown as ClipboardItemConstructor),
  }: {
    clipboard?: Pick<Clipboard, "write"> | null;
    ClipboardItemType?: ClipboardItemConstructor | null;
  } = {},
): Promise<void> {
  if (
    !clipboard?.write ||
    !ClipboardItemType ||
    ClipboardItemType.supports?.("image/png") === false
  )
    return Promise.reject(new Error("当前浏览器不支持复制图片。"));

  let png: Promise<Blob>;
  try {
    png = createPng().catch((reason: unknown) => {
      if (reason instanceof Error && reason.message.startsWith("图片")) throw reason;
      throw new Error("图片生成失败，请重试。");
    });
  } catch {
    return Promise.reject(new Error("图片生成失败，请重试。"));
  }

  let item: ClipboardItem;
  try {
    item = new ClipboardItemType({ "image/png": png });
  } catch {
    return Promise.reject(new Error("当前浏览器不支持复制图片。"));
  }

  try {
    return Promise.resolve(clipboard.write([item])).catch((reason: unknown) => {
      if (reason instanceof Error && reason.message.startsWith("图片")) throw reason;
      throw new Error("浏览器未允许复制图片，请检查剪贴板权限后重试。");
    });
  } catch {
    return Promise.reject(new Error("浏览器未允许复制图片，请检查剪贴板权限后重试。"));
  }
}

export function copyRasterImage(image: HTMLImageElement) {
  return writeImageClipboard(() => imagePngBlob(image));
}

export function useImageActions({
  rootRef,
  menuLabel,
  copyLabel,
  fallbackAlt,
  resolveImage,
  copyImage,
  focusTarget,
  extraItems,
}: {
  rootRef: RefObject<HTMLElement | null>;
  menuLabel: string;
  copyLabel: string;
  fallbackAlt: string;
  resolveImage: (root: HTMLElement, target: EventTarget | null) => HTMLImageElement | null;
  copyImage: (image: HTMLImageElement) => void | Promise<void>;
  focusTarget?: (root: HTMLElement) => HTMLElement | null;
  extraItems?: ContextMenuItem[];
}) {
  const { openMenu, menu } = useContextMenu();
  const [viewer, setViewer] = useState<ImageViewerState>();
  const viewerRef = useRef<ImageViewerState | undefined>(undefined);
  viewerRef.current = viewer;

  const closeViewer = useCallback(
    (restoreFocus = true) => {
      const trigger =
        viewerRef.current?.trigger ??
        (focusTarget && rootRef.current ? focusTarget(rootRef.current) : null);
      setViewer(undefined);
      if (!restoreFocus) return;
      requestAnimationFrame(() => {
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      });
    },
    [focusTarget, rootRef],
  );

  const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    const root = rootRef.current;
    if (!root) return;
    const image = resolveImage(root, event.target);
    if (!image) return;
    openMenu(
      event,
      buildImageMenuItems(
        copyLabel,
        {
          copy: () => copyImage(image),
          expand: () => {
            setViewer({
              src: image.currentSrc || image.src,
              alt: image.alt.trim() || fallbackAlt,
              width: image.naturalWidth || Number(image.getAttribute("width")) || 1,
              height: image.naturalHeight || Number(image.getAttribute("height")) || 1,
              trigger:
                focusTarget?.(root) ??
                (document.activeElement instanceof HTMLElement ? document.activeElement : null),
            });
          },
        },
        extraItems,
      ),
      menuLabel,
    );
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const root = rootRef.current;
    if (!root || !resolveImage(root, event.target)) return;
    dispatchKeyboardContextMenu(event, "dialog, [role='menu']");
  };

  return {
    onContextMenu,
    onKeyDown,
    menu: (
      <>
        {menu}
        {viewer ? <ImageLightbox state={viewer} onClose={closeViewer} /> : null}
      </>
    ),
  };
}
