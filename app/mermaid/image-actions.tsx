import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Copy, Maximize2, X } from "lucide-react";
import { dispatchKeyboardContextMenu, useContextMenu, type ContextMenuItem } from "../context-menu";

const COPY_PADDING = 16;
const COPY_SCALE = 2;
const MAX_COPY_SIDE = 4096;
const MAX_COPY_PIXELS = 16_000_000;

export type ClipboardItemConstructor = {
  new (data: Record<string, Blob | Promise<Blob>>): ClipboardItem;
  supports?: (type: string) => boolean;
};

type DiagramViewerState = {
  src: string;
  alt: string;
  width: number;
  height: number;
  trigger: HTMLElement | null;
};

export function diagramCopyGeometry(width: number, height: number) {
  const sourceWidth = Math.max(1, Number.isFinite(width) ? width : 1) + COPY_PADDING * 2;
  const sourceHeight = Math.max(1, Number.isFinite(height) ? height : 1) + COPY_PADDING * 2;
  const scale = Math.min(
    COPY_SCALE,
    MAX_COPY_SIDE / sourceWidth,
    MAX_COPY_SIDE / sourceHeight,
    Math.sqrt(MAX_COPY_PIXELS / (sourceWidth * sourceHeight)),
  );
  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale)),
    padding: Math.max(1, Math.round(COPY_PADDING * scale)),
    scale,
  };
}

export function buildDiagramImageMenuItems(actions: {
  copy: () => void | Promise<void>;
  expand: () => void;
}): ContextMenuItem[] {
  return [
    { label: "复制为图片", icon: Copy, onSelect: actions.copy },
    { label: "展开显示", icon: Maximize2, onSelect: actions.expand },
  ];
}

async function diagramPngBlob(image: HTMLImageElement) {
  if (!image.isConnected) throw new Error("图表已更新，请重试。");
  await image.decode();
  const width = Number(image.getAttribute("width")) || image.naturalWidth;
  const height = Number(image.getAttribute("height")) || image.naturalHeight;
  const geometry = diagramCopyGeometry(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = geometry.width;
  canvas.height = geometry.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("图表图片生成失败，请重试。");
    const preview = image.closest<HTMLElement>(".mermaid-preview");
    if (preview) {
      context.fillStyle = getComputedStyle(preview).backgroundColor;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(
      image,
      geometry.padding,
      geometry.padding,
      Math.round(width * geometry.scale),
      Math.round(height * geometry.scale),
    );
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error("图表图片生成失败，请重试。"))),
        "image/png",
      );
    });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function writeDiagramClipboard(
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
    png = createPng().catch(() => {
      throw new Error("图表图片生成失败，请重试。");
    });
  } catch {
    return Promise.reject(new Error("图表图片生成失败，请重试。"));
  }

  let item: ClipboardItem;
  try {
    item = new ClipboardItemType({ "image/png": png });
  } catch {
    return Promise.reject(new Error("当前浏览器不支持复制图片。"));
  }

  try {
    return Promise.resolve(clipboard.write([item])).catch((reason: unknown) => {
      if (reason instanceof Error && reason.message.startsWith("图表")) throw reason;
      throw new Error("浏览器未允许复制图表图片，请检查剪贴板权限后重试。");
    });
  } catch {
    return Promise.reject(new Error("浏览器未允许复制图表图片，请检查剪贴板权限后重试。"));
  }
}

export function copyDiagramImage(image: HTMLImageElement) {
  return writeDiagramClipboard(() => diagramPngBlob(image));
}

function renderedDiagramImage(root: HTMLElement, target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const rendered = target.closest(".mermaid-rendered");
  if (!rendered || !root.contains(rendered)) return null;
  const image = rendered.querySelector<HTMLImageElement>(".mermaid-preview img.mermaid-image");
  return image?.src && image.naturalWidth > 0 ? image : null;
}

function MermaidImageViewer({
  state,
  onClose,
}: {
  state: DiagramViewerState;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>(".mermaid-lightbox-close")?.focus({
      preventScroll: true,
    });
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="mermaid-lightbox"
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <h2 id={headingId} className="visually-hidden">
        图表预览
      </h2>
      <button
        className="icon-button mermaid-lightbox-close"
        type="button"
        aria-label="关闭图表预览"
        onClick={onClose}
      >
        <X size={18} aria-hidden="true" />
      </button>
      <img
        className="mermaid-lightbox-image"
        src={state.src}
        alt={state.alt}
        width={state.width}
        height={state.height}
        draggable={false}
      />
    </dialog>,
    document.body,
  );
}

export function useMermaidImageActions(rootRef: RefObject<HTMLElement | null>) {
  const { openMenu, menu } = useContextMenu();
  const [viewer, setViewer] = useState<DiagramViewerState>();
  const viewerRef = useRef<DiagramViewerState | undefined>(undefined);
  viewerRef.current = viewer;

  const closeViewer = useCallback(() => {
    const trigger =
      viewerRef.current?.trigger ??
      rootRef.current?.querySelector<HTMLElement>(".mermaid-edit-trigger") ??
      null;
    setViewer(undefined);
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
  }, [rootRef]);

  const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    const root = rootRef.current;
    if (!root) return;
    const image = renderedDiagramImage(root, event.target);
    if (!image) return;
    openMenu(
      event,
      buildDiagramImageMenuItems({
        copy: () => copyDiagramImage(image),
        expand: () => {
          const width = Number(image.getAttribute("width")) || image.naturalWidth;
          const height = Number(image.getAttribute("height")) || image.naturalHeight;
          setViewer({
            src: image.currentSrc || image.src,
            alt: image.alt.trim() || "Mermaid 图表",
            width,
            height,
            trigger: root.querySelector<HTMLElement>(".mermaid-edit-trigger"),
          });
        },
      }),
      "图表",
    );
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const root = rootRef.current;
    if (!root || !renderedDiagramImage(root, event.target)) return;
    dispatchKeyboardContextMenu(event, "dialog, [role='menu']");
  };

  return {
    onContextMenu,
    onKeyDown,
    menu: (
      <>
        {menu}
        {viewer ? <MermaidImageViewer state={viewer} onClose={closeViewer} /> : null}
      </>
    ),
  };
}
