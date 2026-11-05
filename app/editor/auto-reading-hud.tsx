import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Focus, Pause, Play, RotateCcw } from "lucide-react";

export type SpeedPreset = {
  rate: number; // 滚动速度 (px/s)
  multiplier: string;
  label: string;
};

// 基于自然口播语速基准配置的 6 档语速梯队
export const BROADCAST_SPEED_PRESETS: SpeedPreset[] = [
  { rate: 20, multiplier: "0.7x", label: "沉稳解说" },
  { rate: 26, multiplier: "0.9x", label: "舒缓叙述" },
  { rate: 32, multiplier: "1.0x", label: "标准口播" },
  { rate: 40, multiplier: "1.3x", label: "生动快语" },
  { rate: 50, multiplier: "1.6x", label: "高密资讯" },
  { rate: 65, multiplier: "2.0x", label: "疾速播报" },
];

const STORAGE_SPEED_KEY = "xiangying_auto_reading_preset_index";
const STORAGE_FOCUS_KEY = "xiangying_auto_reading_focus";

function loadInitialPresetIndex(): number {
  try {
    const saved = localStorage.getItem(STORAGE_SPEED_KEY);
    if (saved !== null) {
      const parsed = parseInt(saved, 10);
      if (!Number.isNaN(parsed) && parsed >= 0 && parsed < BROADCAST_SPEED_PRESETS.length) {
        return parsed;
      }
    }
  } catch {
    // Storage access may be restricted
  }
  return 2; // 默认 1.0x 标准口播
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

  let bestElement: HTMLElement | null = null;
  let minDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    const rect = el.getBoundingClientRect();
    if (rect.top <= focalY && rect.bottom >= focalY) {
      bestElement = el;
      break;
    }
    const elCenter = (rect.top + rect.bottom) / 2;
    const dist = Math.abs(elCenter - focalY);
    if (dist < minDistance) {
      minDistance = dist;
      bestElement = el;
    }
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

export function AutoReadingHUD({ scrollTargetRef, onExit }: AutoReadingHUDProps) {
  const [presetIndex, setPresetIndex] = useState<number>(loadInitialPresetIndex);
  const [focusReading, setFocusReading] = useState<boolean>(loadInitialFocusReading);
  const [isPlaying, setIsPlaying] = useState<boolean>(true);

  const currentPreset = BROADCAST_SPEED_PRESETS[presetIndex];
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
      const next = Math.max(0, prev - 1);
      try {
        localStorage.setItem(STORAGE_SPEED_KEY, String(next));
      } catch {}
      return next;
    });
  }, []);

  const handleSpeedUp = useCallback(() => {
    setPresetIndex((prev) => {
      const next = Math.min(BROADCAST_SPEED_PRESETS.length - 1, prev + 1);
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
    container.scrollTo({ top: 0, behavior: "smooth" });
    requestAnimationFrame(() => {
      updateFocalElement(container, focusReadingRef.current);
    });
  }, [scrollTargetRef]);

  const togglePlay = useCallback(() => {
    setIsPlaying((prev) => {
      const next = !prev;
      isPlayingRef.current = next;
      if (next) {
        const container = scrollTargetRef.current;
        if (container) {
          const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
          if (container.scrollTop >= maxScroll - 2) {
            container.scrollTop = 0;
          }
        }
        lastTimeRef.current = null;
      }
      return next;
    });
  }, [scrollTargetRef]);

  // 主滚动循环与视线焦点同步
  useEffect(() => {
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

      // 同步更新段落视线焦点
      updateFocalElement(container, focusReadingRef.current);
      animFrameRef.current = requestAnimationFrame(loop);
    };

    if (isPlaying) {
      animFrameRef.current = requestAnimationFrame(loop);
    } else {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      lastTimeRef.current = null;
    }

    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      lastTimeRef.current = null;
    };
  }, [isPlaying, scrollTargetRef]);

  // 手动滚动监听：同步累加器并实时刷新聚焦段落
  useEffect(() => {
    const container = scrollTargetRef.current;
    if (!container) return;

    const onManualScroll = () => {
      subpixelRef.current = 0;
      lastTimeRef.current = null;
      updateFocalElement(container, focusReadingRef.current);
    };

    container.addEventListener("wheel", onManualScroll, { passive: true });
    container.addEventListener("touchmove", onManualScroll, { passive: true });
    // 初始化聚焦
    updateFocalElement(container, focusReadingRef.current);

    return () => {
      container.removeEventListener("wheel", onManualScroll);
      container.removeEventListener("touchmove", onManualScroll);
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
          sentinel = await (
            navigator as unknown as {
              wakeLock: { request: (type: string) => Promise<{ release: () => Promise<void> }> };
            }
          ).wakeLock.request("screen");
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
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      if (event.code === "Space" || event.key === " ") {
        event.preventDefault();
        togglePlay();
        return;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowRight" || event.key === "+") {
        event.preventDefault();
        handleSpeedUp();
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "-") {
        event.preventDefault();
        handleSpeedDown();
        return;
      }

      if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        toggleFocusReading();
        return;
      }

      if (event.key === "Home" || event.key === "r" || event.key === "R") {
        event.preventDefault();
        handleRewind();
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay, handleSpeedUp, handleSpeedDown, handleRewind, toggleFocusReading]);

  // 滚轮刻度位置（以基准档位为中心的平滑横向位移）
  const trackOffset = (2 - presetIndex) * 16;

  return (
    <div className="auto-reading-hud" role="region" aria-label="自动阅读控制">
      <button
        type="button"
        className="auto-reading-btn auto-reading-btn--icon"
        aria-label="回正到顶部 (Home / R)"
        title="回正到顶部 (Home / R)"
        onClick={handleRewind}
      >
        <RotateCcw size={15} strokeWidth={2} />
      </button>

      <button
        type="button"
        className={`auto-reading-btn auto-reading-btn--icon auto-reading-btn--play ${isPlaying ? "is-playing" : ""}`}
        aria-label={isPlaying ? "暂停滚动 (空格键)" : "继续滚动 (空格键)"}
        title={isPlaying ? "暂停滚动 (空格键)" : "继续滚动 (空格键)"}
        onClick={togglePlay}
      >
        {isPlaying ? <Pause size={15} strokeWidth={2.2} /> : <Play size={15} strokeWidth={2.2} />}
      </button>

      {/* 视线段落聚焦切换 */}
      <button
        type="button"
        className={`auto-reading-btn auto-reading-btn--icon auto-reading-btn--focus ${focusReading ? "is-active" : ""}`}
        aria-label={focusReading ? "关闭段落聚焦 (F)" : "开启段落聚焦 (F)"}
        title={focusReading ? "关闭段落聚焦 (F)" : "开启段落聚焦 (F)"}
        onClick={toggleFocusReading}
      >
        <Focus size={15} strokeWidth={2} />
      </button>

      <span className="auto-reading-divider" aria-hidden="true" />

      {/* 横向刻度拨盘滚轮控制器 */}
      <div className="auto-reading-dial-group" role="group" aria-label="口播语速调节">
        <button
          type="button"
          className="auto-reading-btn auto-reading-btn--dial-arrow"
          aria-label="减速 (← 或 -)"
          title="减速 (← 或 -)"
          disabled={presetIndex <= 0}
          onClick={handleSpeedDown}
        >
          <ChevronLeft size={14} strokeWidth={2.4} />
        </button>

        <div
          className="auto-reading-dial"
          role="status"
          aria-label={`当前语速 ${currentPreset.multiplier} ${currentPreset.label}，点击左侧减速，点击右侧加速`}
          title="点击左侧减速，点击右侧加速"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const clickX = event.clientX - rect.left;
            if (clickX < rect.width / 2) {
              handleSpeedDown();
            } else {
              handleSpeedUp();
            }
          }}
        >
          <div
            className="auto-reading-dial-track"
            style={{ transform: `translateX(${trackOffset}px)` }}
            aria-hidden="true"
          >
            {[-2, -1, 0, 1, 2, 3, 4, 5, 6, 7].map((notch) => (
              <span
                key={notch}
                className={`auto-reading-dial-notch ${notch === presetIndex ? "is-active" : ""}`}
              />
            ))}
          </div>
          <div className="auto-reading-dial-readout">
            <span className="auto-reading-dial-mult">{currentPreset.multiplier}</span>
            <span className="auto-reading-dial-name">{currentPreset.label}</span>
          </div>
        </div>

        <button
          type="button"
          className="auto-reading-btn auto-reading-btn--dial-arrow"
          aria-label="加速 (→ 或 +)"
          title="加速 (→ 或 +)"
          disabled={presetIndex >= BROADCAST_SPEED_PRESETS.length - 1}
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
        title="退出自动阅读 (Esc)"
        onClick={onExit}
      >
        <span>退出</span>
        <kbd className="auto-reading-kbd">Esc</kbd>
      </button>
    </div>
  );
}
