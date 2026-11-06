import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Focus, Pause, Play, RotateCcw, X } from "lucide-react";

export type SpeedPreset = {
  rate: number; // 滚动速度 (px/s)
  multiplier: string;
};

// 覆盖 16~80 px/s 自然朗读节奏的十档纯数字倍率梯度
export const READING_SPEED_PRESETS: SpeedPreset[] = [
  { rate: 16, multiplier: "0.5x" },
  { rate: 22, multiplier: "0.7x" },
  { rate: 26, multiplier: "0.8x" },
  { rate: 32, multiplier: "1.0x" }, // 默认基准档位（索引 3）
  { rate: 38, multiplier: "1.2x" },
  { rate: 45, multiplier: "1.4x" },
  { rate: 52, multiplier: "1.6x" },
  { rate: 58, multiplier: "1.8x" },
  { rate: 65, multiplier: "2.0x" },
  { rate: 80, multiplier: "2.5x" },
];

const STORAGE_SPEED_KEY = "xiangying_auto_reading_preset_index";
const STORAGE_FOCUS_KEY = "xiangying_auto_reading_focus";
export const DIAL_TICK_WIDTH = 28;

export function clampPresetIndex(index: number) {
  return Math.max(0, Math.min(READING_SPEED_PRESETS.length - 1, index));
}

export function stepPresetIndex(currentIndex: number, delta: number) {
  return clampPresetIndex(currentIndex + delta);
}

export function presetIndexForDrag(
  startIndex: number,
  deltaX: number,
  tickWidth = DIAL_TICK_WIDTH,
) {
  return clampPresetIndex(startIndex - Math.round(deltaX / tickWidth));
}

export function presetIndexForTap(
  currentIndex: number,
  offsetFromCenter: number,
  tickWidth = DIAL_TICK_WIDTH,
) {
  return clampPresetIndex(currentIndex + Math.round(offsetFromCenter / tickWidth));
}

function loadInitialPresetIndex(): number {
  try {
    const saved = localStorage.getItem(STORAGE_SPEED_KEY);
    if (saved !== null) {
      const parsed = parseInt(saved, 10);
      if (!Number.isNaN(parsed) && parsed >= 0 && parsed < READING_SPEED_PRESETS.length) {
        return parsed;
      }
    }
  } catch {
    // Storage access may be restricted
  }
  return 3; // 默认 1.0x
}

function loadInitialFocusReading(): boolean {
  try {
    const saved = localStorage.getItem(STORAGE_FOCUS_KEY);
    if (saved !== null) {
      return saved === "true";
    }
  } catch {
    // ignore
  }
  return true; // 默认开启段落聚焦
}

/**
 * 计算视口黄金视线位置（顶部 40% 处），精确定位当前聚焦的正文段落或标题
 */
export function updateFocalElement(container: HTMLElement | null, enabled: boolean) {
  if (!container) return;
  if (!enabled) {
    container.classList.remove("is-focus-reading");
    const current = container.querySelector(".is-reading-focus");
    if (current) current.classList.remove("is-reading-focus");
    return;
  }

  container.classList.add("is-focus-reading");
  const containerRect = container.getBoundingClientRect();
  // 黄金视线高度定在视口上部 40% 处（最适宜朗读录音的视线水平）
  const focalY = containerRect.top + containerRect.height * 0.4;

  const candidates = container.querySelectorAll<HTMLElement>(".note-title-input, .note-prose > *");
  if (!candidates.length) return;

  // 正文块按文档顺序垂直排列；二分查找避免长文末尾逐块读取布局。
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (candidates[middle].getBoundingClientRect().bottom < focalY) low = middle + 1;
    else high = middle;
  }
  const next = candidates[low] ?? null;
  const before = candidates[low - 1] ?? null;
  const nextRect = next?.getBoundingClientRect();
  let bestElement = next;
  if (!nextRect || nextRect.top > focalY) {
    const beforeRect = before?.getBoundingClientRect();
    const beforeDistance = beforeRect
      ? Math.abs((beforeRect.top + beforeRect.bottom) / 2 - focalY)
      : Infinity;
    const nextDistance = nextRect
      ? Math.abs((nextRect.top + nextRect.bottom) / 2 - focalY)
      : Infinity;
    if (beforeDistance <= nextDistance) bestElement = before;
  }

  const previous = container.querySelector(".is-reading-focus");
  if (previous !== bestElement) {
    if (previous) previous.classList.remove("is-reading-focus");
    if (bestElement) bestElement.classList.add("is-reading-focus");
  }
}

export type AutoReadingHUDProps = {
  scrollTargetRef: React.RefObject<HTMLElement | null>;
  onExit?: () => void;
};

type ReadingKeyActions = {
  togglePlay: () => void;
  handleSpeedUp: () => void;
  handleSpeedDown: () => void;
  toggleFocusReading: () => void;
  handleRewind: () => void;
};

type ReadingKeyEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "isComposing" | "keyCode" | "defaultPrevented" | "repeat" | "preventDefault"
> & { target: EventTarget | null };

function closestTarget(target: EventTarget | null, selector: string) {
  if (
    target &&
    typeof target === "object" &&
    "closest" in target &&
    typeof target.closest === "function"
  ) {
    return target.closest(selector);
  }
  return null;
}

export function handleReadingKeyDown(event: ReadingKeyEvent, actions: ReadingKeyActions) {
  if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return false;

  if (closestTarget(event.target, "dialog[open], [role='dialog'], [role='menu']")) return false;
  if (
    closestTarget(
      event.target,
      "input:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), [contenteditable='true']",
    )
  )
    return false;

  const isSpace = event.code === "Space" || event.key === " ";
  if (
    isSpace &&
    closestTarget(
      event.target,
      "button, a[href], select, [role='button'], [role='menuitem'], [role='option'], [role='switch'], [role='checkbox'], [role='radio']",
    )
  )
    return false;

  if (isSpace) {
    if (event.repeat) return false;
    event.preventDefault();
    actions.togglePlay();
    return true;
  }

  if (event.key === "ArrowUp" || event.key === "ArrowRight" || event.key === "+") {
    event.preventDefault();
    actions.handleSpeedUp();
    return true;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "-") {
    event.preventDefault();
    actions.handleSpeedDown();
    return true;
  }

  if (event.key === "f" || event.key === "F") {
    if (event.repeat) return false;
    event.preventDefault();
    actions.toggleFocusReading();
    return true;
  }

  if (event.key === "Home" || event.key === "r" || event.key === "R") {
    if (event.key !== "Home" && event.repeat) return false;
    event.preventDefault();
    actions.handleRewind();
    return true;
  }

  return false;
}

export function AutoReadingHUD({ scrollTargetRef, onExit }: AutoReadingHUDProps) {
  const [presetIndex, setPresetIndex] = useState<number>(loadInitialPresetIndex);
  const [focusReading, setFocusReading] = useState<boolean>(loadInitialFocusReading);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragOffsetPx, setDragOffsetPx] = useState<number>(0);
  const dragStartRef = useRef<{ x: number; index: number; moved: boolean } | null>(null);

  const currentPreset = READING_SPEED_PRESETS[presetIndex];
  const speedRef = useRef(currentPreset.rate);
  speedRef.current = currentPreset.rate;

  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const focusReadingRef = useRef(focusReading);
  focusReadingRef.current = focusReading;

  const subpixelRef = useRef(0);
  const lastTimeRef = useRef<number | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const handleSpeedDown = useCallback(() => {
    setPresetIndex((prev) => {
      const next = stepPresetIndex(prev, -1);
      try {
        localStorage.setItem(STORAGE_SPEED_KEY, String(next));
      } catch {}
      return next;
    });
  }, []);

  const handleSpeedUp = useCallback(() => {
    setPresetIndex((prev) => {
      const next = stepPresetIndex(prev, 1);
      try {
        localStorage.setItem(STORAGE_SPEED_KEY, String(next));
      } catch {}
      return next;
    });
  }, []);

  const toggleFocusReading = useCallback(() => {
    setFocusReading((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_FOCUS_KEY, String(next));
      } catch {}
      updateFocalElement(scrollTargetRef.current, next);
      return next;
    });
  }, [scrollTargetRef]);

  const handleRewind = useCallback(() => {
    const container = scrollTargetRef.current;
    if (!container) return;
    subpixelRef.current = 0;
    lastTimeRef.current = null;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo({
      top: 0,
      behavior: reduceMotion || isPlayingRef.current ? "auto" : "smooth",
    });
    updateFocalElement(container, focusReadingRef.current);
  }, [scrollTargetRef]);

  const togglePlay = useCallback(() => {
    setIsPlaying((current) => !current);
  }, []);

  const handleDialPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragStartRef.current = {
        x: e.clientX,
        index: presetIndex,
        moved: false,
      };
      setIsDragging(true);
      setDragOffsetPx(0);
    },
    [presetIndex],
  );

  const handleDialPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    const deltaX = e.clientX - dragStartRef.current.x;
    if (Math.abs(deltaX) > 3) {
      dragStartRef.current.moved = true;
    }
    setDragOffsetPx(deltaX);

    // 物理刻度逻辑：鼠标向左拉刻度带（deltaX < 0），右侧更高的档位滑向中心指针（升档）
    // 鼠标向右拉刻度带（deltaX > 0），左侧更低的档位滑向中心指针（降档）
    setPresetIndex(presetIndexForDrag(dragStartRef.current.index, deltaX));
  }, []);

  const handleDialPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    const { x, index, moved } = dragStartRef.current;
    dragStartRef.current = null;
    setIsDragging(false);
    setDragOffsetPx(0);

    if (!moved) {
      // 纯点击：计算点击位置相对于中心指针的距离，直接将该刻度对齐到中心指针
      const rect = e.currentTarget.getBoundingClientRect();
      const centerX = rect.width / 2;
      const offsetFromCenter = e.clientX - rect.left - centerX;
      const target = presetIndexForTap(index, offsetFromCenter);
      if (target !== index) {
        setPresetIndex(target);
        try {
          localStorage.setItem(STORAGE_SPEED_KEY, String(target));
        } catch {}
      }
    } else {
      const deltaX = e.clientX - x;
      const finalIndex = presetIndexForDrag(index, deltaX);
      setPresetIndex(finalIndex);
      try {
        localStorage.setItem(STORAGE_SPEED_KEY, String(finalIndex));
      } catch {}
    }
  }, []);

  const handleDialPointerCancel = useCallback(() => {
    dragStartRef.current = null;
    setIsDragging(false);
    setDragOffsetPx(0);
  }, []);

  // 主滚动循环
  useEffect(() => {
    if (!isPlaying) {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      lastTimeRef.current = null;
      return;
    }

    const container = scrollTargetRef.current;
    if (container) {
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      if (container.scrollTop >= maxScroll - 2) {
        container.scrollTop = 0;
      }
    }
    lastTimeRef.current = null;

    const loop = (timestamp: number) => {
      if (!isPlayingRef.current) {
        lastTimeRef.current = null;
        return;
      }

      const container = scrollTargetRef.current;
      if (!container) {
        animFrameRef.current = requestAnimationFrame(loop);
        return;
      }

      if (lastTimeRef.current === null) {
        lastTimeRef.current = timestamp;
        animFrameRef.current = requestAnimationFrame(loop);
        return;
      }

      const elapsed = Math.min(100, timestamp - lastTimeRef.current);
      lastTimeRef.current = timestamp;

      const pxToMove = (speedRef.current * elapsed) / 1000;
      subpixelRef.current += pxToMove;

      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);

      if (container.scrollTop >= maxScroll - 1) {
        setIsPlaying(false);
        isPlayingRef.current = false;
        lastTimeRef.current = null;
        updateFocalElement(container, focusReadingRef.current);
        return;
      }

      if (subpixelRef.current >= 1) {
        const step = Math.floor(subpixelRef.current);
        subpixelRef.current -= step;
        const targetTop = Math.min(maxScroll, container.scrollTop + step);
        container.scrollTop = targetTop;

        if (targetTop >= maxScroll) {
          setIsPlaying(false);
          isPlayingRef.current = false;
          lastTimeRef.current = null;
          updateFocalElement(container, focusReadingRef.current);
          return;
        }
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);

    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      lastTimeRef.current = null;
    };
  }, [isPlaying, scrollTargetRef]);

  // 手动滚动监听：同步累加器；滚动事件负责覆盖鼠标、触控、键盘和滚动条
  useEffect(() => {
    const container = scrollTargetRef.current;
    if (!container) return;

    const onManualInput = () => {
      subpixelRef.current = 0;
      lastTimeRef.current = null;
    };
    const onScroll = () => {
      updateFocalElement(container, focusReadingRef.current);
    };

    container.addEventListener("wheel", onManualInput, { passive: true });
    container.addEventListener("touchmove", onManualInput, { passive: true });
    container.addEventListener("scroll", onScroll, { passive: true });
    // 初始化聚焦
    onScroll();

    return () => {
      container.removeEventListener("wheel", onManualInput);
      container.removeEventListener("touchmove", onManualInput);
      container.removeEventListener("scroll", onScroll);
      updateFocalElement(container, false);
    };
  }, [scrollTargetRef]);

  // Screen WakeLock API：自动阅读时保持屏幕常亮
  useEffect(() => {
    let sentinel: { release: () => Promise<void> } | null = null;
    let active = true;

    const requestLock = async () => {
      if (
        typeof navigator !== "undefined" &&
        "wakeLock" in navigator &&
        document.visibilityState === "visible" &&
        active
      ) {
        try {
          const requestedSentinel = await (
            navigator as unknown as {
              wakeLock: { request: (type: string) => Promise<{ release: () => Promise<void> }> };
            }
          ).wakeLock.request("screen");
          if (!active || document.visibilityState !== "visible") {
            await requestedSentinel.release().catch(() => undefined);
            return;
          }
          sentinel = requestedSentinel;
        } catch {
          // Non-fatal if permission not granted
        }
      }
    };

    const releaseLock = async () => {
      if (sentinel) {
        try {
          await sentinel.release();
        } catch {
          // ignore
        }
        sentinel = null;
      }
    };

    void requestLock();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void requestLock();
      } else {
        void releaseLock();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void releaseLock();
    };
  }, []);

  // Keyboard navigation within reading mode
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      handleReadingKeyDown(event, {
        togglePlay,
        handleSpeedUp,
        handleSpeedDown,
        toggleFocusReading,
        handleRewind,
      });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay, handleSpeedUp, handleSpeedDown, handleRewind, toggleFocusReading]);

  // 滚轮刻度位置（以基准档位为中心的平滑横向位移）
  const baseIndex = isDragging && dragStartRef.current ? dragStartRef.current.index : presetIndex;
  const trackOffset = -(baseIndex * DIAL_TICK_WIDTH) + (isDragging ? dragOffsetPx : 0);

  return (
    <div className="auto-reading-hud" role="region" aria-label="自动阅读控制">
      <button
        type="button"
        className="auto-reading-btn auto-reading-btn--icon"
        aria-label="回正到顶部 (Home / R)"
        onClick={handleRewind}
      >
        <RotateCcw size={15} strokeWidth={2} />
      </button>

      <button
        type="button"
        className={`auto-reading-btn auto-reading-btn--icon auto-reading-btn--play ${isPlaying ? "is-playing" : ""}`}
        aria-label={isPlaying ? "暂停滚动 (空格键)" : "继续滚动 (空格键)"}
        aria-pressed={isPlaying}
        onClick={togglePlay}
      >
        {isPlaying ? <Pause size={15} strokeWidth={2.2} /> : <Play size={15} strokeWidth={2.2} />}
      </button>

      {/* 视线段落聚焦切换 */}
      <button
        type="button"
        className={`auto-reading-btn auto-reading-btn--icon auto-reading-btn--focus ${focusReading ? "is-active" : ""}`}
        aria-label={focusReading ? "关闭段落聚焦 (F)" : "开启段落聚焦 (F)"}
        aria-pressed={focusReading}
        onClick={toggleFocusReading}
      >
        <Focus size={15} strokeWidth={2} />
      </button>

      <span className="auto-reading-divider" aria-hidden="true" />

      {/* 横向刻度拨盘滚轮控制器 */}
      <div className="auto-reading-dial-group" role="group" aria-label="速度调节">
        <button
          type="button"
          className="auto-reading-btn auto-reading-btn--dial-arrow"
          aria-label="减速 (← 或 -)"
          disabled={presetIndex <= 0}
          onClick={handleSpeedDown}
        >
          <ChevronLeft size={14} strokeWidth={2.4} />
        </button>

        <div
          className={`auto-reading-dial ${isDragging ? "is-dragging" : ""}`}
          role="slider"
          tabIndex={0}
          aria-label="阅读速度"
          aria-valuemin={0}
          aria-valuemax={READING_SPEED_PRESETS.length - 1}
          aria-valuenow={presetIndex}
          aria-valuetext={currentPreset.multiplier}
          aria-orientation="horizontal"
          aria-description="拖拽刻度带对准中心指针调节速度"
          onPointerDown={handleDialPointerDown}
          onPointerMove={handleDialPointerMove}
          onPointerUp={handleDialPointerUp}
          onPointerCancel={handleDialPointerCancel}
        >
          {/* 正中央选择指针 */}
          <div className="auto-reading-dial-needle" aria-hidden="true">
            <span className="auto-reading-dial-needle-pip" />
            <span className="auto-reading-dial-needle-bar" />
          </div>

          {/* 实时移动对齐的刻度带 */}
          <div
            className="auto-reading-dial-track"
            style={{
              transform: `translateX(${trackOffset}px)`,
              transition: isDragging
                ? "none"
                : "transform var(--motion-panel) var(--motion-ease-out)",
            }}
            aria-hidden="true"
          >
            {READING_SPEED_PRESETS.map((preset, i) => (
              <div
                key={preset.multiplier}
                className={`auto-reading-dial-tick ${i === presetIndex ? "is-active" : ""}`}
                style={{ left: `${i * DIAL_TICK_WIDTH}px` }}
              >
                <span className="auto-reading-dial-tick-line" />
              </div>
            ))}
          </div>
          <div className="auto-reading-dial-readout">
            <span className="auto-reading-dial-mult">{currentPreset.multiplier}</span>
          </div>
        </div>

        <button
          type="button"
          className="auto-reading-btn auto-reading-btn--dial-arrow"
          aria-label="加速 (→ 或 +)"
          disabled={presetIndex >= READING_SPEED_PRESETS.length - 1}
          onClick={handleSpeedUp}
        >
          <ChevronRight size={14} strokeWidth={2.4} />
        </button>
      </div>

      <span className="auto-reading-divider" aria-hidden="true" />

      <button
        type="button"
        className="auto-reading-btn auto-reading-btn--exit"
        aria-label="退出自动阅读 (Esc)"
        onClick={onExit}
      >
        <X className="auto-reading-exit-icon" size={16} strokeWidth={2} aria-hidden="true" />
        <span className="auto-reading-exit-label">退出</span>
        <kbd className="auto-reading-kbd">Esc</kbd>
      </button>
    </div>
  );
}
