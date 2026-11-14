import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Trash2, X } from "lucide-react";
import { createUuid } from "../uuid";
import { FloatingScrollbar } from "../floating-scrollbar";
import { computeScrollEdges, type ScrollEdges } from "../workspace/use-scroll-edges";
import {
  collectAnnotations,
  findAnnotationRanges,
  type AnnotationRecord,
} from "./highlight-annotation";

type SelectionPoint = { left: number; top: number };
const RAIL_CARD_WIDTH = 220;
const COMPACT_CARD_WIDTH = 300;

type ComposerState = {
  id: string;
  note: string;
  quote: string;
  from: number;
  to: number;
  doc: ProseMirrorNode;
  noteId: string;
  point: SelectionPoint;
};

type CompactState = {
  id: string;
  top: number;
  bottom: number;
  left: number;
};

function sameAnnotations(left: AnnotationRecord[], right: AnnotationRecord[]) {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.id === right[index]?.id &&
        item.note === right[index]?.note &&
        item.quote === right[index]?.quote &&
        item.from === right[index]?.from &&
        item.to === right[index]?.to,
    )
  );
}

function selectionPoint(editor: Editor, position: number): SelectionPoint {
  try {
    const coords = editor.view.coordsAtPos(position);
    return { left: coords.left, top: coords.bottom + 10 };
  } catch {
    return { left: window.innerWidth / 2 - 150, top: 120 };
  }
}

function clampPopupPoint(left: number, top: number, width = 300, height = 280) {
  return {
    left: Math.max(12, Math.min(left, window.innerWidth - width - 12)),
    top: Math.max(12, Math.min(top, window.innerHeight - height)),
  };
}

function useScrollFade(targetRef: RefObject<HTMLElement | null>, dependencies: readonly unknown[]) {
  const [edges, setEdges] = useState<ScrollEdges>({ before: false, after: false });

  useLayoutEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let frame = 0;
    let previous: ScrollEdges | null = null;
    const update = () => {
      frame = 0;
      const next = computeScrollEdges(target.scrollTop, target.scrollHeight, target.clientHeight);
      if (previous && previous.before === next.before && previous.after === next.after) return;
      previous = next;
      setEdges((current) =>
        current.before === next.before && current.after === next.after ? current : next,
      );
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(update);
    };
    update();
    target.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(target);
    const content = target.firstElementChild;
    if (content) observer.observe(content);
    return () => {
      target.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [targetRef, ...dependencies]);

  return edges;
}

function AnnotationTextarea({
  fieldId,
  value,
  locked,
  maxHeight = 220,
  onChange,
  onCommit,
  onCancel,
}: {
  fieldId: string;
  value: string;
  locked: boolean;
  maxHeight?: number;
  onChange: (note: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
    const scrollElement = field.closest<HTMLElement>(".editor-scroll");
    if (scrollElement && scrollElement.scrollLeft !== 0) {
      scrollElement.scrollLeft = 0;
    }
  }, []);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, maxHeight)}px`;
  }, [maxHeight, value]);

  const edges = useScrollFade(fieldRef, [value, maxHeight]);

  return (
    <>
      <label className="visually-hidden" htmlFor={fieldId}>
        批注内容
      </label>
      <div className="annotation-note-editor-shell">
        <div
          className={`annotation-note-editor-scroll${edges.before ? " has-scroll-before" : ""}${edges.after ? " has-scroll-after" : ""}`}
        >
          <textarea
            ref={fieldRef}
            id={fieldId}
            className="annotation-note-editor-field floating-scrollbar-target"
            value={value}
            rows={1}
            disabled={locked}
            placeholder="写下批注……"
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onCancel();
                return;
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (!locked) onCommit();
              }
            }}
          />
        </div>
        <FloatingScrollbar
          scrollTargetRef={fieldRef}
          controlsId={fieldId}
          ariaLabel="滚动批注内容"
          placement="right"
        />
      </div>
    </>
  );
}

function AnnotationComposer({
  state,
  mobile,
  locked,
  onDraftChange,
  onSave,
  onClose,
}: {
  state: ComposerState;
  mobile: boolean;
  locked: boolean;
  onDraftChange: (note: string) => void;
  onSave: (note: string) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState(state.note);
  const noteRef = useRef(note);
  noteRef.current = note;
  const [position, setPosition] = useState(() =>
    clampPopupPoint(state.point.left, state.point.top, 276, 180),
  );
  const trimmed = note.trim();
  const closedRef = useRef(false);

  const updateNote = (value: string) => {
    setNote(value);
    onDraftChange(value);
  };
  const close = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  };
  const commit = (value: string) => {
    if (closedRef.current) return;
    closedRef.current = true;
    onSave(value);
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || mobile) return;
    setPosition(
      clampPopupPoint(
        state.point.left,
        state.point.top +
          (state.point.top + root.offsetHeight > window.innerHeight - 12
            ? -root.offsetHeight - 16
            : 0),
        276,
        root.offsetHeight,
      ),
    );
  }, [mobile, note, state.point.left, state.point.top]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        const current = noteRef.current.trim();
        if (current && !locked) {
          commit(current);
        } else {
          close();
        }
      }
    };
    const focusin = (event: FocusEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      const current = noteRef.current.trim();
      if (current && !locked) commit(current);
      else close();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", focusin, true);
    window.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", focusin, true);
      window.removeEventListener("keydown", keydown, true);
    };
  }, [locked, onClose, onSave]);

  return createPortal(
    <>
      {mobile && <div className="annotation-sheet-backdrop" aria-hidden="true" />}
      <article
        ref={rootRef}
        className={`annotation-card annotation-card--compact is-editing is-composer${mobile ? " annotation-composer--sheet" : ""}`}
        style={mobile ? undefined : position}
        role="dialog"
        aria-label="添加批注"
      >
        <button className="annotation-close-button" type="button" aria-label="取消" onClick={close}>
          <X size={13} />
        </button>
        {state.quote && (
          <div className="annotation-card-quote">
            <span>{state.quote}</span>
          </div>
        )}
        <div className="annotation-card-body annotation-card-body--editing">
          <AnnotationTextarea
            fieldId={`annotation-note-${state.id}`}
            value={note}
            locked={locked}
            maxHeight={160}
            onChange={updateNote}
            onCommit={() => {
              if (trimmed) commit(trimmed);
            }}
            onCancel={close}
          />
        </div>
      </article>
    </>,
    document.body,
  );
}

function AnnotationCard({
  annotation,
  active = false,
  hovered = false,
  editing,
  locked,
  onStartEdit,
  onFinishEdit,
  onSaveNote,
  onDraftChange,
  onDelete,
  onOutside,
  onHover,
  variant,
  register,
  pageScrollRef,
}: {
  annotation: AnnotationRecord;
  active?: boolean;
  hovered?: boolean;
  editing: boolean;
  locked: boolean;
  onStartEdit: () => void;
  onFinishEdit: () => void;
  onSaveNote: (note: string) => void;
  onDraftChange?: (note: string) => void;
  onDelete: () => void;
  onOutside?: () => void;
  onHover?: (hovered: boolean) => void;
  variant: "rail" | "compact";
  register?: (element: HTMLElement | null) => void;
  pageScrollRef?: RefObject<HTMLElement | null>;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLButtonElement>(null);
  const readScrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(annotation.note);
  const draftRef = useRef(draft);
  const commitRef = useRef<() => void>(() => {});
  const cancelRef = useRef<() => void>(() => {});
  const outsideRef = useRef(onOutside);
  const closedRef = useRef(false);
  const readScrollId = `annotation-read-${annotation.id}`;
  const readEdges = useScrollFade(readScrollRef, [annotation.note, editing]);
  draftRef.current = draft;
  outsideRef.current = onOutside;

  useEffect(() => {
    if (editing) {
      closedRef.current = false;
      setDraft(annotation.note);
    }
  }, [annotation.note, editing]);

  const updateDraft = (value: string) => {
    setDraft(value);
    onDraftChange?.(value);
  };

  const commit = (restoreFocus: boolean) => {
    if (closedRef.current) return;
    closedRef.current = true;
    const next = draftRef.current.trim();
    if (next && next !== annotation.note.trim()) onSaveNote(next);
    onFinishEdit();
    if (restoreFocus) {
      requestAnimationFrame(() => textRef.current?.focus({ preventScroll: true }));
    }
  };

  const cancel = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    setDraft(annotation.note);
    onFinishEdit();
  };
  commitRef.current = () => commit(false);
  cancelRef.current = cancel;

  useEffect(() => {
    if (!editing && !onOutside) return;
    const outside = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      if (editing) commitRef.current();
      outsideRef.current?.();
    };
    const focusin = (event: FocusEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      if (editing) commitRef.current();
      outsideRef.current?.();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (editing) cancelRef.current();
      outsideRef.current?.();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", focusin, true);
    window.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", focusin, true);
      window.removeEventListener("keydown", keydown, true);
    };
  }, [editing, onOutside]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const forwardWheel = (event: WheelEvent) => {
      const page = pageScrollRef?.current;
      if (!page) return;
      const scrollBody = root.querySelector<HTMLElement>(
        ".annotation-card-scroll, .annotation-note-editor-field",
      );
      if (
        scrollBody?.contains(event.target as Node) &&
        scrollBody.scrollHeight > scrollBody.clientHeight + 1
      ) {
        const atTop = scrollBody.scrollTop <= 0;
        const atBottom =
          scrollBody.scrollTop + scrollBody.clientHeight >= scrollBody.scrollHeight - 1;
        if ((event.deltaY < 0 && !atTop) || (event.deltaY > 0 && !atBottom)) return;
      }
      event.preventDefault();
      const delta =
        event.deltaMode === 1
          ? event.deltaY * 16
          : event.deltaMode === 2
            ? event.deltaY * page.clientHeight
            : event.deltaY;
      page.scrollBy({ top: delta, behavior: "auto" });
    };
    root.addEventListener("wheel", forwardWheel, { passive: false });
    return () => root.removeEventListener("wheel", forwardWheel);
  }, [pageScrollRef]);

  return (
    <article
      ref={(element) => {
        rootRef.current = element;
        register?.(element);
      }}
      className={`annotation-card annotation-card--${variant}${active ? " is-active" : ""}${hovered ? " is-hovered" : ""}${editing ? " is-editing" : ""}`}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      role={variant === "compact" ? "dialog" : undefined}
      aria-label={variant === "compact" ? "批注" : undefined}
    >
      {!locked && (
        <button
          className="annotation-delete-button"
          type="button"
          aria-label="删除批注"
          onClick={onDelete}
        >
          <Trash2 size={13} />
        </button>
      )}
      {annotation.quote && (
        <div className="annotation-card-quote">
          <span>{annotation.quote}</span>
        </div>
      )}
      <div className="annotation-card-body-swap" key={editing ? "editing" : "reading"}>
        {editing ? (
          <div className="annotation-card-body annotation-card-body--editing">
            <AnnotationTextarea
              fieldId={`annotation-inline-${annotation.id}`}
              value={draft}
              locked={locked}
              maxHeight={variant === "rail" ? 220 : 280}
              onChange={updateDraft}
              onCommit={() => commit(true)}
              onCancel={cancel}
            />
          </div>
        ) : (
          <div className="annotation-card-body annotation-card-body--read">
            <div className="annotation-card-scroll-shell">
              <div className="annotation-card-read-shell">
                <div
                  ref={readScrollRef}
                  id={readScrollId}
                  className={`annotation-card-scroll floating-scrollbar-target${readEdges.before ? " has-scroll-before" : ""}${readEdges.after ? " has-scroll-after" : ""}`}
                >
                  <button
                    ref={textRef}
                    className="annotation-card-read-button"
                    type="button"
                    disabled={locked}
                    onClick={onStartEdit}
                  >
                    <span className="annotation-card-text">{annotation.note}</span>
                  </button>
                </div>
              </div>
              <FloatingScrollbar
                scrollTargetRef={readScrollRef}
                controlsId={readScrollId}
                ariaLabel="滚动批注内容"
                placement="right"
              />
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function AnnotationBubble({
  annotation,
  active,
  hovered,
  editing,
  locked,
  onStartEdit,
  onFinishEdit,
  onSaveNote,
  onDraftChange,
  onDelete,
  onHover,
  register,
  pageScrollRef,
}: {
  annotation: AnnotationRecord;
  active: boolean;
  hovered: boolean;
  editing: boolean;
  locked: boolean;
  onStartEdit: () => void;
  onFinishEdit: () => void;
  onSaveNote: (note: string) => void;
  onDraftChange?: (note: string) => void;
  onDelete: () => void;
  onHover: (hovered: boolean) => void;
  register: (element: HTMLElement | null) => void;
  pageScrollRef: RefObject<HTMLElement | null>;
}) {
  return (
    <AnnotationCard
      annotation={annotation}
      active={active}
      hovered={hovered}
      editing={editing}
      locked={locked}
      onStartEdit={onStartEdit}
      onFinishEdit={onFinishEdit}
      onSaveNote={onSaveNote}
      onDraftChange={onDraftChange}
      onDelete={onDelete}
      onHover={onHover}
      variant="rail"
      register={register}
      pageScrollRef={pageScrollRef}
    />
  );
}

function CompactAnnotationCard({
  annotation,
  anchor,
  mobile,
  locked,
  editing,
  onStartEdit,
  onFinishEdit,
  onSaveNote,
  onDraftChange,
  onDelete,
  onClose,
  pageScrollRef,
}: {
  annotation: AnnotationRecord;
  anchor: { top: number; bottom: number; left: number };
  mobile: boolean;
  locked: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onFinishEdit: () => void;
  onSaveNote: (note: string) => void;
  onDraftChange?: (note: string) => void;
  onDelete: () => void;
  onClose: () => void;
  pageScrollRef: RefObject<HTMLElement | null>;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => ({
    top: anchor.bottom + 6,
    left: Math.max(12, Math.min(anchor.left, window.innerWidth - COMPACT_CARD_WIDTH - 12)),
  }));

  useLayoutEffect(() => {
    if (mobile) return;
    const element = anchorRef.current;
    if (!element) return;
    const place = () => {
      const height = element.offsetHeight;
      const margin = 12;
      const gap = 6;
      const below = anchor.bottom + gap;
      const above = anchor.top - height - gap;
      const spaceBelow = window.innerHeight - margin - below;
      const spaceAbove = anchor.top - gap - margin;
      const top = Math.max(
        margin,
        Math.min(
          spaceBelow >= height || spaceBelow >= spaceAbove ? below : above,
          window.innerHeight - height - margin,
        ),
      );
      const left = Math.max(
        margin,
        Math.min(anchor.left, window.innerWidth - COMPACT_CARD_WIDTH - margin),
      );
      setPosition((current) =>
        current.top === top && current.left === left ? current : { top, left },
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor.bottom, anchor.left, anchor.top, mobile]);

  return createPortal(
    <>
      <div
        ref={anchorRef}
        className={`annotation-compact-anchor${mobile ? " annotation-compact-anchor--sheet" : ""}`}
        style={mobile ? undefined : { top: `${position.top}px`, left: `${position.left}px` }}
      >
        <AnnotationCard
          annotation={annotation}
          active
          editing={editing}
          locked={locked}
          onStartEdit={onStartEdit}
          onFinishEdit={onFinishEdit}
          onSaveNote={onSaveNote}
          onDraftChange={onDraftChange}
          onDelete={onDelete}
          onOutside={onClose}
          variant="compact"
          pageScrollRef={pageScrollRef}
        />
      </div>
      {mobile && <div className="annotation-sheet-backdrop" aria-hidden="true" />}
    </>,
    document.body,
  );
}

function AnnotationLayer({
  editor,
  scrollRef,
  annotations,
  railVisible,
  expandedId,
  hoveredId,
  editId,
  locked,
  mobile,
  onToggle,
  onClear,
  onHover,
  onStartEdit,
  onFinishEdit,
  onSaveNote,
  onCardDraftChange,
  onDelete,
}: {
  editor: Editor;
  scrollRef: RefObject<HTMLDivElement | null>;
  annotations: AnnotationRecord[];
  railVisible: boolean;
  expandedId: string | null;
  hoveredId: string | null;
  editId: string | null;
  locked: boolean;
  mobile: boolean;
  onToggle: (id: string) => void;
  onClear: () => void;
  onHover: (id: string | null) => void;
  onStartEdit: (id: string) => void;
  onFinishEdit: () => void;
  onSaveNote: (id: string, note: string) => void;
  onCardDraftChange: (id: string, note: string) => void;
  onDelete: (id: string) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const bubbleRefs = useRef(new Map<string, HTMLElement>());
  const [compact, setCompact] = useState<CompactState | null>(null);
  const showRail = railVisible;

  const updatePositions = useCallback(() => {
    const layer = layerRef.current;
    if (!layer || editor.isDestroyed) return;
    const layerRect = layer.getBoundingClientRect();
    const visible: Array<{ id: string; anchor: number }> = [];

    for (const annotation of annotations) {
      const mark = editor.view.dom.querySelector<HTMLElement>(
        `.note-annotation[data-annotation-id="${CSS.escape(annotation.id)}"]`,
      );
      if (!mark) continue;
      const rect = mark.getBoundingClientRect();
      const anchor = rect.top - layerRect.top;
      visible.push({ id: annotation.id, anchor });
    }

    if (!showRail) {
      for (const bubble of bubbleRefs.current.values()) {
        bubble.style.display = "none";
      }
      return;
    }

    visible.sort((left, right) => left.anchor - right.anchor);
    let previousBottom = 16;
    const positioned: Array<{ id: string; top: number; height: number; anchor: number }> = [];
    for (const item of visible) {
      const bubble = bubbleRefs.current.get(item.id);
      if (!bubble) continue;
      const height = bubble.offsetHeight || 60;
      const desired = Math.max(16, item.anchor - 6);
      const top = Math.max(desired, previousBottom + 10);
      positioned.push({ id: item.id, top, height, anchor: item.anchor });
      previousBottom = top + height;
    }
    for (const item of positioned) {
      const bubble = bubbleRefs.current.get(item.id);
      if (!bubble) continue;
      bubble.style.display = "block";
      bubble.style.top = `${Math.round(item.top)}px`;
    }
  }, [annotations, editor, showRail]);

  useLayoutEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updatePositions();
      });
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    if (layerRef.current) observer.observe(layerRef.current);
    observer.observe(editor.view.dom);
    const documentElement = editor.view.dom.closest(".editor-document");
    if (documentElement) observer.observe(documentElement);
    for (const bubble of bubbleRefs.current.values()) observer.observe(bubble);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [editor, expandedId, showRail, updatePositions]);

  const compactAnnotation = compact
    ? (annotations.find((annotation) => annotation.id === compact.id) ?? null)
    : null;
  useEffect(() => {
    if (showRail || !expandedId) {
      setCompact(null);
      return;
    }
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const mark = editor.view.dom.querySelector<HTMLElement>(
          `.note-annotation[data-annotation-id="${CSS.escape(expandedId)}"]`,
        );
        if (!mark) {
          setCompact(null);
          return;
        }
        const rect = mark.getBoundingClientRect();
        const viewport = scrollElement.getBoundingClientRect();
        const viewportTop = Math.max(viewport.top, 0);
        const viewportBottom = Math.min(viewport.bottom, window.innerHeight);
        if (rect.bottom < viewportTop + 8 || rect.top > viewportBottom - 8) {
          setCompact(null);
          onClear();
          return;
        }
        setCompact({
          id: expandedId,
          top: rect.top,
          bottom: rect.bottom,
          left: Math.max(12, Math.min(rect.left, window.innerWidth - COMPACT_CARD_WIDTH - 12)),
        });
      });
    };
    update();
    scrollElement.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scrollElement.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [annotations, editor, expandedId, onClear, scrollRef, showRail]);

  return (
    <>
      {showRail && (
        <div
          ref={layerRef}
          className="annotation-layer annotation-layer--rail"
          role="complementary"
          aria-label="批注"
        >
          {annotations.map((annotation) => (
            <AnnotationBubble
              key={`bubble-${annotation.id}`}
              annotation={annotation}
              active={expandedId === annotation.id}
              hovered={hoveredId === annotation.id}
              editing={editId === annotation.id}
              locked={locked}
              onStartEdit={() => onStartEdit(annotation.id)}
              onFinishEdit={onFinishEdit}
              onSaveNote={(note) => onSaveNote(annotation.id, note)}
              onDraftChange={(note) => onCardDraftChange(annotation.id, note)}
              onDelete={() => onDelete(annotation.id)}
              onHover={(hovered) => onHover(hovered ? annotation.id : null)}
              register={(element) => {
                if (element) bubbleRefs.current.set(annotation.id, element);
                else bubbleRefs.current.delete(annotation.id);
              }}
              pageScrollRef={scrollRef}
            />
          ))}
        </div>
      )}
      {compactAnnotation && compact && (
        <CompactAnnotationCard
          annotation={compactAnnotation}
          anchor={{ top: compact.top, bottom: compact.bottom, left: compact.left }}
          mobile={mobile}
          locked={locked}
          editing={editId === compactAnnotation.id}
          onStartEdit={() => onStartEdit(compactAnnotation.id)}
          onFinishEdit={onFinishEdit}
          onSaveNote={(note) => onSaveNote(compactAnnotation.id, note)}
          onDraftChange={(note) => onCardDraftChange(compactAnnotation.id, note)}
          onDelete={() => {
            setCompact(null);
            onDelete(compactAnnotation.id);
          }}
          onClose={() => {
            setCompact(null);
            if (expandedId === compactAnnotation.id) onToggle(compactAnnotation.id);
          }}
          pageScrollRef={scrollRef}
        />
      )}
    </>
  );
}

export function useEditorAnnotations({
  editor,
  noteId,
  contentVersion,
  locked,
  deleted,
  scrollRef,
  layoutMode = "three-column",
  mobile,
}: {
  editor: Editor | null;
  noteId: string;
  contentVersion: number;
  locked: boolean;
  deleted: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  layoutMode?: "cards" | "three-column";
  mobile: boolean;
}) {
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [wideEnough, setWideEnough] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const composerDraftRef = useRef("");
  const editDraftRef = useRef<{ id: string; note: string } | null>(null);

  const refresh = useCallback(() => {
    if (!editor || editor.isDestroyed) {
      setAnnotations((current) => (current.length ? [] : current));
      return;
    }
    const next = collectAnnotations(editor.state.doc);
    setAnnotations((current) => (sameAnnotations(current, next) ? current : next));
  }, [editor]);

  useEffect(() => {
    setComposer(null);
    setExpandedId(null);
    setHoveredId(null);
    setEditId(null);
    composerDraftRef.current = "";
    editDraftRef.current = null;
    refresh();
  }, [noteId, refresh]);

  useEffect(() => {
    refresh();
  }, [contentVersion, refresh]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    };
    editor.on("update", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      editor.off("update", schedule);
    };
  }, [editor, refresh]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth;
      const documentWidth = Math.min(820, width - 96);
      setWideEnough(!mobile && (width - documentWidth) / 2 >= RAIL_CARD_WIDTH + 24);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mobile, scrollRef]);

  useEffect(() => {
    if (locked || deleted) {
      setComposer(null);
      setEditId(null);
    }
  }, [deleted, locked]);

  const openCreate = useCallback(
    (from: number, to: number) => {
      if (!editor || editor.isDestroyed || locked || deleted || from >= to) return;
      composerDraftRef.current = "";
      editDraftRef.current = null;
      setComposer({
        id: createUuid(),
        note: "",
        quote: editor.state.doc
          .textBetween(from, to, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120),
        from,
        to,
        doc: editor.state.doc,
        noteId,
        point: selectionPoint(editor, to),
      });
    },
    [deleted, editor, locked, noteId],
  );

  const startEdit = useCallback(
    (id: string) => {
      if (!editor || editor.isDestroyed || locked || deleted) return;
      const annotation = annotationsRef.current.find((candidate) => candidate.id === id);
      if (!annotation) return;
      composerDraftRef.current = "";
      editDraftRef.current = { id, note: annotation.note };
      setExpandedId(id);
      setEditId(id);
    },
    [deleted, editor, locked],
  );
  const finishEdit = useCallback(() => {
    editDraftRef.current = null;
    setEditId(null);
  }, []);

  const deleteAnnotations = useCallback(
    (ids: string[]) => {
      if (!editor || editor.isDestroyed || locked || deleted) return;
      const markType = editor.schema.marks.noteAnnotation;
      if (!markType) return;
      let transaction = editor.state.tr;
      let changed = false;
      for (const id of ids) {
        for (const range of findAnnotationRanges(transaction.doc, id)) {
          transaction = transaction.removeMark(range.from, range.to, markType);
          changed = true;
        }
      }
      if (!changed) return;
      editor.view.dispatch(transaction.scrollIntoView());
      setExpandedId((current) => (current && ids.includes(current) ? null : current));
      setEditId((current) => (current && ids.includes(current) ? null : current));
    },
    [deleted, editor, locked],
  );

  const deleteAnnotation = useCallback(
    (id: string) => deleteAnnotations([id]),
    [deleteAnnotations],
  );

  const saveAnnotationNote = useCallback(
    (id: string, note: string) => {
      if (!editor || editor.isDestroyed || locked || deleted) return;
      const markType = editor.schema.marks.noteAnnotation;
      if (!markType) return;
      let transaction = editor.state.tr;
      const ranges = findAnnotationRanges(transaction.doc, id);
      if (!ranges.length) return;
      note = note.replace(/\r\n?/g, "\n");
      const mark = markType.create({ id, note });
      for (const range of ranges) transaction = transaction.addMark(range.from, range.to, mark);
      editor.view.dispatch(transaction.scrollIntoView());
      requestAnimationFrame(refresh);
    },
    [deleted, editor, locked, refresh],
  );

  const saveComposer = useCallback(
    (note: string) => {
      if (!editor || editor.isDestroyed || !composer || locked || deleted) return;
      if (composer.noteId !== noteId || composer.doc !== editor.state.doc) {
        setComposer(null);
        return;
      }
      note = note.replace(/\r\n?/g, "\n");
      const markType = editor.schema.marks.noteAnnotation;
      if (!markType) return;
      const transaction = editor.state.tr;
      if (composer.from < 0 || composer.to > transaction.doc.content.size) {
        setComposer(null);
        return;
      }
      const mark = markType.create({ id: composer.id, note });
      editor.view.dispatch(transaction.addMark(composer.from, composer.to, mark).scrollIntoView());
      composerDraftRef.current = "";
      setComposer(null);
      setExpandedId(composer.id);
      setEditId(null);
      requestAnimationFrame(refresh);
    },
    [composer, deleted, editor, locked, noteId, refresh],
  );

  const closeComposer = useCallback(() => {
    composerDraftRef.current = "";
    setComposer(null);
  }, []);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const flushDrafts = () => {
      const composerNote = composerDraftRef.current.trim();
      if (composer && composerNote && !locked && !deleted) {
        composerDraftRef.current = "";
        saveComposer(composerNote);
      }
      const editing = editDraftRef.current;
      if (editing && editing.note.trim() && !locked && !deleted) {
        editDraftRef.current = null;
        saveAnnotationNote(editing.id, editing.note);
      }
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushDrafts();
    };
    document.addEventListener("visibilitychange", flushWhenHidden, true);
    window.addEventListener("beforeunload", flushDrafts, true);
    window.addEventListener("pagehide", flushDrafts, true);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden, true);
      window.removeEventListener("beforeunload", flushDrafts, true);
      window.removeEventListener("pagehide", flushDrafts, true);
    };
  }, [composer, deleted, editor, locked, saveAnnotationNote, saveComposer]);
  const clearActive = useCallback(() => {
    setExpandedId(null);
    setEditId(null);
  }, []);
  const toggleExpanded = useCallback((id: string) => {
    setEditId(null);
    setExpandedId((current) => (current === id ? null : id));
  }, []);
  const railVisible = !mobile && layoutMode === "cards" && wideEnough && annotations.length > 0;

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom;
    for (const mark of dom.querySelectorAll<HTMLElement>(".note-annotation")) {
      const id = mark.dataset.annotationId;
      mark.classList.toggle("is-active", id === expandedId);
      mark.classList.toggle("is-hovered", id === hoveredId);
    }
  }, [editor, expandedId, hoveredId, annotations]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom;
    const onMouseOver = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const mark = target?.closest<HTMLElement>(".note-annotation[data-annotation-id]");
      setHoveredId(mark?.getAttribute("data-annotation-id") ?? null);
    };
    const onMouseLeave = () => setHoveredId(null);
    dom.addEventListener("mouseover", onMouseOver);
    dom.addEventListener("mouseleave", onMouseLeave);
    return () => {
      dom.removeEventListener("mouseover", onMouseOver);
      dom.removeEventListener("mouseleave", onMouseLeave);
    };
  }, [editor]);

  const overlay =
    editor && annotations.length > 0 ? (
      <AnnotationLayer
        editor={editor}
        scrollRef={scrollRef}
        annotations={annotations}
        railVisible={railVisible}
        expandedId={expandedId}
        hoveredId={hoveredId}
        editId={editId}
        locked={locked || deleted}
        mobile={mobile}
        onToggle={toggleExpanded}
        onClear={clearActive}
        onHover={setHoveredId}
        onStartEdit={startEdit}
        onFinishEdit={finishEdit}
        onSaveNote={saveAnnotationNote}
        onCardDraftChange={(id, note) => {
          editDraftRef.current = { id, note };
        }}
        onDelete={deleteAnnotation}
      />
    ) : null;

  const composerNode = composer ? (
    <AnnotationComposer
      state={composer}
      mobile={mobile}
      locked={locked || deleted}
      onDraftChange={(note) => {
        composerDraftRef.current = note;
      }}
      onSave={saveComposer}
      onClose={closeComposer}
    />
  ) : null;

  return {
    overlay,
    composer: composerNode,
    openCreate,
    startEdit,
    deleteAnnotations,
    toggleExpanded,
    clearActive,
  };
}
