import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Pause, Play, Plus, RotateCcw } from "lucide-react";

const SPEED_STEPS = [0.4, 0.6, 0.8, 1.0, 1.2, 1.5, 1.8, 2.2, 2.8, 3.5];
const BASE_SPEED_PX_PER_SEC = 36;
const STORAGE_KEY = "xiangying_auto_reading_speed";

function loadInitialSpeed(): number {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = parseFloat(saved);
      if (!Number.isNaN(parsed) && parsed >= 0.3 && parsed <= 4.0) {
        return Math.round(parsed * 10) / 10;
      }
    }
  } catch {
    // Storage access may be restricted
  }
  return 1.0;
}

export type AutoReadingHUDProps = {
  scrollTargetRef: React.RefObject<HTMLElement | null>;
  onExit?: () => void;
};

export function AutoReadingHUD({ scrollTargetRef, onExit }: AutoReadingHUDProps) {
  const [speed, setSpeed] = useState<number>(loadInitialSpeed);
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const subpixelRef = useRef(0);
  const lastTimeRef = useRef<number | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const speedBadgeRef = useRef<HTMLDivElement | null>(null);

  const saveSpeed = useCallback((newSpeed: number) => {
    try {
      localStorage.setItem(STORAGE_KEY, newSpeed.toFixed(1));
    } catch {
      // ignore
    }
  }, []);

  const handleSpeedChange = useCallback(
    (updater: (prev: number) => number) => {
      setSpeed((prev) => {
        const next = Math.max(0.3, Math.min(4.0, updater(prev)));
        const rounded = Math.round(next * 100) / 100;
        speedRef.current = rounded;
        saveSpeed(rounded);
        return rounded;
      });
    },
    [saveSpeed],
  );

  const handleSpeedDown = useCallback(() => {
    handleSpeedChange((current) => {
      for (let i = SPEED_STEPS.length - 1; i >= 0; i--) {
        if (SPEED_STEPS[i] < current - 0.05) {
          return SPEED_STEPS[i];
        }
      }
      return Math.max(0.3, current - 0.1);
    });
  }, [handleSpeedChange]);

  const handleSpeedUp = useCallback(() => {
    handleSpeedChange((current) => {
      for (let i = 0; i < SPEED_STEPS.length; i++) {
        if (SPEED_STEPS[i] > current + 0.05) {
          return SPEED_STEPS[i];
        }
      }
      return Math.min(4.0, current + 0.1);
    });
  }, [handleSpeedChange]);

  const handleRewind = useCallback(() => {
    const container = scrollTargetRef.current;
    if (!container) return;
    subpixelRef.current = 0;
    lastTimeRef.current = null;
    container.scrollTo({ top: 0, behavior: "smooth" });
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

  // Main scroll loop
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

      const pxToMove = (BASE_SPEED_PX_PER_SEC * speedRef.current * elapsed) / 1000;
      subpixelRef.current += pxToMove;

      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);

      if (container.scrollTop >= maxScroll - 1) {
        setIsPlaying(false);
        isPlayingRef.current = false;
        lastTimeRef.current = null;
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
          return;
        }
      }

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

  // Manual scroll listener: synchronize accumulator when user touches or wheels
  useEffect(() => {
    const container = scrollTargetRef.current;
    if (!container) return;

    const onManualScroll = () => {
      subpixelRef.current = 0;
      lastTimeRef.current = null;
    };

    container.addEventListener("wheel", onManualScroll, { passive: true });
    container.addEventListener("touchmove", onManualScroll, { passive: true });

    return () => {
      container.removeEventListener("wheel", onManualScroll);
      container.removeEventListener("touchmove", onManualScroll);
    };
  }, [scrollTargetRef]);

  // Mouse wheel listener on speed badge for smooth continuous adjustment
  useEffect(() => {
    const badge = speedBadgeRef.current;
    if (!badge) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY;
      if (delta < 0) {
        handleSpeedChange((prev) => prev + 0.05);
      } else if (delta > 0) {
        handleSpeedChange((prev) => prev - 0.05);
      }
    };

    badge.addEventListener("wheel", onWheel, { passive: false });
    return () => badge.removeEventListener("wheel", onWheel);
  }, [handleSpeedChange]);

  // Screen WakeLock API: prevent display sleep while auto-reading
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

      if (event.key === "ArrowUp" || event.key === "+") {
        event.preventDefault();
        handleSpeedUp();
        return;
      }

      if (event.key === "ArrowDown" || event.key === "-") {
        event.preventDefault();
        handleSpeedDown();
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
  }, [togglePlay, handleSpeedUp, handleSpeedDown, handleRewind]);

  const speedDisplay = `${speed.toFixed(1)}x`;

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

      <div className="auto-reading-stepper" role="group" aria-label="速度调节">
        <button
          type="button"
          className="auto-reading-btn auto-reading-btn--stepper"
          aria-label="减速 (↓ 或 -)"
          title="减速 (↓ 或 -)"
          disabled={speed <= 0.3}
          onClick={handleSpeedDown}
        >
          <Minus size={13} strokeWidth={2.4} />
        </button>

        <div
          ref={speedBadgeRef}
          className="auto-reading-speed-badge"
          role="status"
          aria-label={`当前速度 ${speedDisplay}，可使用鼠标滚轮微调`}
          title="滚轮可平滑微调速度"
        >
          <span className="auto-reading-speed-val">{speedDisplay}</span>
        </div>

        <button
          type="button"
          className="auto-reading-btn auto-reading-btn--stepper"
          aria-label="加速 (↑ 或 +)"
          title="加速 (↑ 或 +)"
          disabled={speed >= 4.0}
          onClick={handleSpeedUp}
        >
          <Plus size={13} strokeWidth={2.4} />
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
