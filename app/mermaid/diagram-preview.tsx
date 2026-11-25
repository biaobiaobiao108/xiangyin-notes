import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { FloatingScrollbar } from "../floating-scrollbar";
import {
  canRetryDiagram,
  diagramErrorMessage,
  diagramImage,
  measureDiagram,
  renderDiagram,
} from "./render";
import type { DiagramLayout, DiagramResult } from "./protocol";

type Rendered = { source: string; result: DiagramResult; layout: DiagramLayout };
type Preview = Rendered | { source: string; error: string; retry: boolean };

export const MemoDiagramPreviews = createContext<Map<
  number,
  {
    preview: Preview;
    naturalSize: boolean;
    count: number;
  }
> | null>(null);

function sameLayout(left: DiagramLayout | undefined, right: DiagramLayout) {
  return (
    left?.width === right.width &&
    left.fontFamily === right.fontFamily &&
    left.fontFamilyMono === right.fontFamilyMono
  );
}

export function DiagramPreview({
  source,
  keepPrevious = false,
}: {
  source: string;
  keepPrevious?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollId = useId();
  const [visible, setVisible] = useState(false);
  const [layout, setLayout] = useState<DiagramLayout>();
  const [preview, setPreview] = useState<Preview>();
  const [image, setImage] = useState<ReturnType<typeof diagramImage> & { preview: Preview }>();
  const [imageError, setImageError] = useState<Preview>();
  const [attempt, setAttempt] = useState(0);
  const [naturalSize, setNaturalSize] = useState(false);
  const memoPreviews = useContext(MemoDiagramPreviews);

  const memoPosition = () => {
    const root = rootRef.current;
    const block = root?.closest(".memo-mermaid, .mermaid-code-block");
    const prose = block?.closest(".note-prose");
    if (!block || !prose) return;
    const diagrams = Array.from(prose.querySelectorAll(".memo-mermaid, .mermaid-code-block"));
    return { index: diagrams.indexOf(block), count: diagrams.length };
  };
  const restoreMemoPreview = useEffectEvent(() => {
    const root = rootRef.current;
    if (!memoPreviews || !root) return;
    const position = memoPosition();
    if (!position) return;
    // The reader and composer mount different trees. Keep the prior diagram visible
    // while its edited source renders, and prefer a source match when blocks move.
    const current = memoPreviews.get(position.index);
    const last =
      current?.preview.source === source
        ? current
        : (Array.from(memoPreviews.values()).find(({ preview }) => preview.source === source) ??
          (current?.count === position.count ? current : undefined));
    if (!last || ("error" in last.preview && last.preview.source !== source)) return;
    setLayout(measureDiagram(root));
    setPreview(last.preview);
    setNaturalSize(last.naturalSize);
  });
  useLayoutEffect(() => {
    restoreMemoPreview();
  }, [memoPreviews]);

  useLayoutEffect(() => {
    if (!memoPreviews || !preview || preview.source !== source) return;
    const position = memoPosition();
    if (position) memoPreviews.set(position.index, { preview, naturalSize, count: position.count });
  }, [memoPreviews, preview, naturalSize, source]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) setVisible(entry.isIntersecting);
      },
      { rootMargin: "160px" },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !visible) return;
    let timer: ReturnType<typeof setTimeout>;
    const measure = () => {
      const next = measureDiagram(root);
      setLayout((current) => (sameLayout(current, next) ? current : next));
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 100);
    });
    observer.observe(root);
    measure();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [visible]);

  const hasRenderedLayout = useEffectEvent(
    (next: DiagramLayout) =>
      preview?.source === source && "result" in preview && sameLayout(preview.layout, next),
  );
  useEffect(() => {
    if (!visible || !layout?.width || !source.trim()) return;
    if (hasRenderedLayout(layout)) return;
    const controller = new AbortController();
    void renderDiagram({ ...layout, source }, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setPreview({ source, result, layout });
      },
      (reason) => {
        if (!controller.signal.aborted)
          setPreview({
            source,
            error: diagramErrorMessage(reason),
            retry: canRetryDiagram(reason),
          });
      },
    );
    return () => controller.abort();
  }, [source, visible, layout, attempt]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !preview || !("result" in preview)) return;
    let imageUrl: string | undefined;
    const applyTheme = () => {
      try {
        const next = diagramImage(preview.result, root);
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        imageUrl = next.url;
        setImage({ ...next, preview });
        setImageError(undefined);
      } catch {
        setImageError(preview);
      }
    };
    applyTheme();
    const theme = new MutationObserver(applyTheme);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      theme.disconnect();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [preview]);

  const current = keepPrevious || memoPreviews || preview?.source === source ? preview : undefined;
  const result = current && "result" in current ? current.result : undefined;
  const currentImage = current && image?.preview === current ? image : undefined;
  const error =
    current && "error" in current
      ? current.error
      : current && imageError === current
        ? "图表图片无法显示"
        : undefined;
  const canRetry = current && "retry" in current ? current.retry : true;
  const canEnlarge = !!result && result.width > (layout?.width ?? Infinity);

  return (
    <div ref={rootRef} className="mermaid-preview" contentEditable={false}>
      {!source.trim() ? (
        <div className="mermaid-status">空图表</div>
      ) : error ? (
        <div className="mermaid-status mermaid-error">
          <span role="status">{error}</span>
          {canRetry ? (
            <button
              className="mermaid-action"
              type="button"
              onClick={() => {
                setPreview(undefined);
                setAttempt((value) => value + 1);
              }}
            >
              重试
            </button>
          ) : null}
        </div>
      ) : result && currentImage ? (
        <>
          <div className="mermaid-viewport">
            <div ref={scrollRef} id={scrollId} className="mermaid-scroll">
              <img
                className={`mermaid-image${canEnlarge && naturalSize ? " is-natural-size" : ""}`}
                src={currentImage.url}
                alt={currentImage.alt}
                width={result.width}
                height={result.height}
                draggable={false}
                onError={() => setImageError(current)}
              />
            </div>
            {canEnlarge && naturalSize ? (
              <FloatingScrollbar
                scrollTargetRef={scrollRef}
                controlsId={scrollId}
                ariaLabel="横向滚动图表"
                placement="bottom"
                orientation="horizontal"
              />
            ) : null}
          </div>
          {canEnlarge ? (
            <button
              className="mermaid-action mermaid-size"
              type="button"
              aria-pressed={naturalSize}
              onClick={() => setNaturalSize(!naturalSize)}
            >
              {naturalSize ? "适合宽度" : "原始尺寸"}
            </button>
          ) : null}
        </>
      ) : (
        <div className="mermaid-status" role={visible ? "status" : undefined} aria-busy={visible}>
          {visible ? "正在渲染图表…" : "Mermaid 图表"}
        </div>
      )}
    </div>
  );
}
