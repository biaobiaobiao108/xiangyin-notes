import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, Scan, X } from "lucide-react";

const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const ZOOM_STEP = 25;
const KEYBOARD_PAN_STEP = 40;
const STAGE_GUTTER = 16;
const FRAME_PADDING = 16;
const FRAME_BORDER = 1;
const FRAME_CHROME = (FRAME_PADDING + FRAME_BORDER) * 2;

type Size = {
  width: number;
  height: number;
};

type Point = {
  x: number;
  y: number;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  startPan: Point;
};

export type ImageViewerState = {
  src: string;
  alt: string;
  width: number;
  height: number;
  trigger: HTMLElement | null;
};

export function imageLightboxFit(
  naturalWidth: number,
  naturalHeight: number,
  stageWidth: number,
  stageHeight: number,
) {
  const width = Math.max(1, Number.isFinite(naturalWidth) ? naturalWidth : 1);
  const height = Math.max(1, Number.isFinite(naturalHeight) ? naturalHeight : 1);
  const availableWidth = Math.max(1, stageWidth - STAGE_GUTTER * 2 - FRAME_CHROME);
  const availableHeight = Math.max(1, stageHeight - STAGE_GUTTER * 2 - FRAME_CHROME);
  const scale = Math.min(1, availableWidth / width, availableHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale) + FRAME_CHROME),
    height: Math.max(1, Math.round(height * scale) + FRAME_CHROME),
    scale,
  };
}

export function clampImageZoom(value: number) {
  const zoom = Number.isFinite(value) ? value : 100;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom)));
}

export function imageZoomStep(current: number, direction: -1 | 1) {
  return clampImageZoom(current + direction * ZOOM_STEP);
}

export function imagePanBounds(base: Size, stage: Size, zoomPercent: number) {
  const scale = clampImageZoom(zoomPercent) / 100;
  return {
    x: Math.max(0, (base.width * scale - stage.width) / 2),
    y: Math.max(0, (base.height * scale - stage.height) / 2),
  };
}

export function clampImagePan(pan: Point, bounds: Point) {
  return {
    x: Math.min(bounds.x, Math.max(-bounds.x, pan.x)),
    y: Math.min(bounds.y, Math.max(-bounds.y, pan.y)),
  };
}

export function imageClippedEdges(base: Size, stage: Size, zoomPercent: number, pan: Point) {
  const scale = clampImageZoom(zoomPercent) / 100;
  const horizontalGap = (stage.width - base.width * scale) / 2;
  const verticalGap = (stage.height - base.height * scale) / 2;
  const threshold = 0.5;
  return {
    left: horizontalGap + pan.x < -threshold,
    right: horizontalGap - pan.x < -threshold,
    top: verticalGap + pan.y < -threshold,
    bottom: verticalGap - pan.y < -threshold,
  };
}

export function ImageLightbox({
  state,
  onClose,
}: {
  state: ImageViewerState;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const baseSizeRef = useRef<Size>({ width: 1, height: 1 });
  const stageSizeRef = useRef<Size>({ width: 1, height: 1 });
  const zoomRef = useRef(100);
  const panRef = useRef<Point>({ x: 0, y: 0 });
  const pendingPanRef = useRef<Point | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [pannable, setPannable] = useState(false);
  const [dragging, setDragging] = useState(false);
  const headingId = useId();

  const applyViewState = useCallback((zoom: number, pan: Point) => {
    const frame = frameRef.current;
    const stage = stageRef.current;
    if (!frame || !stage) return;
    frame.style.transform = `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom / 100})`;
    const clipped = imageClippedEdges(baseSizeRef.current, stageSizeRef.current, zoom, pan);
    stage.classList.toggle("is-clipped-left", clipped.left);
    stage.classList.toggle("is-clipped-right", clipped.right);
    stage.classList.toggle("is-clipped-top", clipped.top);
    stage.classList.toggle("is-clipped-bottom", clipped.bottom);
  }, []);

  const setView = useCallback(
    (nextZoom: number, nextPan: Point) => {
      const zoom = clampImageZoom(nextZoom);
      const bounds = imagePanBounds(baseSizeRef.current, stageSizeRef.current, zoom);
      const pan = zoom <= 100 ? { x: 0, y: 0 } : clampImagePan(nextPan, bounds);
      const canPan = bounds.x > 0 || bounds.y > 0;
      zoomRef.current = zoom;
      panRef.current = pan;
      applyViewState(zoom, pan);
      setZoomPercent((current) => (current === zoom ? current : zoom));
      setPannable((current) => (current === canPan ? current : canPan));
    },
    [applyViewState],
  );

  const measureStage = useCallback(() => {
    const stage = stageRef.current;
    const frame = frameRef.current;
    if (!stage || !frame || stage.clientWidth <= 0 || stage.clientHeight <= 0) return;
    const stageSize = { width: stage.clientWidth, height: stage.clientHeight };
    const baseSize = imageLightboxFit(state.width, state.height, stageSize.width, stageSize.height);
    stageSizeRef.current = stageSize;
    baseSizeRef.current = baseSize;
    frame.style.setProperty("--image-lightbox-base-width", `${baseSize.width}px`);
    frame.style.setProperty("--image-lightbox-base-height", `${baseSize.height}px`);
    setView(zoomRef.current, panRef.current);
  }, [setView, state.height, state.width]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    measureStage();
    dialog
      .querySelector<HTMLButtonElement>(".image-lightbox-close")
      ?.focus({ preventScroll: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measureStage());
    if (stageRef.current) observer?.observe(stageRef.current);
    window.addEventListener("resize", measureStage);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureStage);
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      if (dialog.open) dialog.close();
    };
  }, [measureStage]);

  const finishDrag = (pointerId?: number) => {
    const drag = dragRef.current;
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (pendingPanRef.current) {
      panRef.current = pendingPanRef.current;
      pendingPanRef.current = null;
      applyViewState(zoomRef.current, panRef.current);
    }
    const frame = frameRef.current;
    frame?.style.removeProperty("transition");
    if (frame?.hasPointerCapture(drag.pointerId)) frame.releasePointerCapture(drag.pointerId);
    dragRef.current = null;
    setDragging(false);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pannable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    stageRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.style.transition = "none";
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPan: panRef.current,
    };
    pendingPanRef.current = panRef.current;
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = imagePanBounds(baseSizeRef.current, stageSizeRef.current, zoomRef.current);
    pendingPanRef.current = clampImagePan(
      {
        x: drag.startPan.x + event.clientX - drag.startX,
        y: drag.startPan.y + event.clientY - drag.startY,
      },
      bounds,
    );
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null;
      const pan = pendingPanRef.current;
      if (!pan) return;
      panRef.current = pan;
      applyViewState(zoomRef.current, pan);
    });
  };

  const onStageKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!pannable) return;
    const delta = {
      ArrowLeft: { x: -KEYBOARD_PAN_STEP, y: 0 },
      ArrowRight: { x: KEYBOARD_PAN_STEP, y: 0 },
      ArrowUp: { x: 0, y: -KEYBOARD_PAN_STEP },
      ArrowDown: { x: 0, y: KEYBOARD_PAN_STEP },
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    setView(zoomRef.current, {
      x: panRef.current.x + delta.x,
      y: panRef.current.y + delta.y,
    });
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="image-lightbox"
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (
          event.target === event.currentTarget ||
          event.target === stageRef.current ||
          event.target === frameRef.current?.parentElement
        )
          onClose();
      }}
    >
      <h2 id={headingId} className="visually-hidden">
        图片预览
      </h2>
      <button
        className="icon-button image-lightbox-close"
        type="button"
        aria-label="关闭图片预览"
        onClick={onClose}
      >
        <X size={18} aria-hidden="true" />
      </button>
      <div
        ref={stageRef}
        className="image-lightbox-stage"
        role="group"
        tabIndex={0}
        aria-label="图片预览区域；放大后可以拖动或使用方向键移动"
        onKeyDown={onStageKeyDown}
      >
        <div className="image-lightbox-enter">
          <div
            ref={frameRef}
            className={`image-lightbox-frame${pannable ? " is-pannable" : ""}${dragging ? " is-dragging" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => finishDrag(event.pointerId)}
            onPointerCancel={(event) => finishDrag(event.pointerId)}
          >
            <img
              className="image-lightbox-image"
              src={state.src}
              alt={state.alt}
              width={state.width}
              height={state.height}
              draggable={false}
            />
          </div>
        </div>
        <div className="image-lightbox-edge image-lightbox-edge--left" aria-hidden="true" />
        <div className="image-lightbox-edge image-lightbox-edge--right" aria-hidden="true" />
        <div className="image-lightbox-edge image-lightbox-edge--top" aria-hidden="true" />
        <div className="image-lightbox-edge image-lightbox-edge--bottom" aria-hidden="true" />
      </div>
      <div className="image-lightbox-toolbar" role="group" aria-label="图片缩放">
        <button
          className="icon-button"
          type="button"
          aria-label="缩小图片"
          disabled={zoomPercent <= MIN_ZOOM}
          onClick={() => setView(imageZoomStep(zoomRef.current, -1), panRef.current)}
        >
          <Minus size={17} aria-hidden="true" />
        </button>
        <output className="image-lightbox-zoom" aria-live="polite" aria-atomic="true">
          {zoomPercent}%
        </output>
        <button
          className="icon-button"
          type="button"
          aria-label="放大图片"
          disabled={zoomPercent >= MAX_ZOOM}
          onClick={() => setView(imageZoomStep(zoomRef.current, 1), panRef.current)}
        >
          <Plus size={17} aria-hidden="true" />
        </button>
        <span className="image-lightbox-divider" aria-hidden="true" />
        <button
          className="icon-button"
          type="button"
          aria-label="适合窗口"
          onClick={() => setView(100, { x: 0, y: 0 })}
        >
          <Scan size={17} aria-hidden="true" />
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
