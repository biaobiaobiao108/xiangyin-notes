import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ChevronDown, MessageSquareText, Pencil, Trash2, X } from "lucide-react";
import { createUuid } from "../uuid";
import { FloatingScrollbar } from "../floating-scrollbar";
import {
  collectAnnotations,
  findAnnotationRanges,
  type AnnotationRecord,
} from "./highlight-annotation";

type SelectionPoint = { left: number; top: number };

type ComposerState = {
  mode: "create" | "edit";
  id: string;
  note: string;
  from: number;
  to: number;
  doc: ProseMirrorNode;
  noteId: string;
  point: SelectionPoint;
};

type CompactState = {
  id: string;
  point: SelectionPoint;
};

function sameAnnotations(left: AnnotationRecord[], right: AnnotationRecord[]) {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.id === right[index]?.id &&
        item.note === right[index]?.note &&
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

function clampPopupPoint(left: number, top: number) {
  return {
    left: Math.max(12, Math.min(left, window.innerWidth - 312)),
    top: Math.max(12, Math.min(top, window.innerHeight - 280)),
  };
}

function AnnotationComposer({
  state,
  mobile,
  locked,
  onSave,
  onDelete,
  onClose,
}: {
  state: ComposerState;
  mobile: boolean;
  locked: boolean;
  onSave: (note: string) => void;
  onDelete: (() => void) | null;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState(state.note);
  const [position, setPosition] = useState(() =>
    clampPopupPoint(state.point.left, state.point.top),
  );
  const trimmed = note.trim();

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || mobile) return;
    setPosition(
      clampPopupPoint(
        state.point.left,
        state.point.top +
          (state.point.top + root.offsetHeight > window.innerHeight - 12
            ? -root.offsetHeight - 24
            : 0),
      ),
    );
  }, [mobile, state.point.left, state.point.top]);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", keydown, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={rootRef}
      className={`annotation-composer${mobile ? " annotation-composer--sheet" : ""}`}
      style={mobile ? undefined : position}
      role="dialog"
      aria-modal="true"
      aria-label={state.mode === "edit" ? "编辑批注" : "添加批注"}
    >
      <div className="annotation-composer-heading">
        <MessageSquareText size={15} aria-hidden="true" />
        <span>{state.mode === "edit" ? "编辑批注" : "添加批注"}</span>
        <button
          className="annotation-icon-button"
          type="button"
          aria-label="关闭批注编辑"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
      <label className="visually-hidden" htmlFor={`annotation-note-${state.id}`}>
        批注内容
      </label>
      <textarea
        ref={fieldRef}
        id={`annotation-note-${state.id}`}
        className="annotation-composer-field"
        value={note}
        rows={4}
        disabled={locked}
        placeholder="写下批注……"
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!locked && trimmed) onSave(trimmed);
          }
        }}
      />
      <div className="annotation-composer-actions">
        {state.mode === "edit" && onDelete && !locked && (
          <button className="annotation-text-button is-danger" type="button" onClick={onDelete}>
            删除
          </button>
        )}
        <span className="annotation-composer-spacer" />
        <button className="annotation-text-button" type="button" onClick={onClose}>
          取消
        </button>
        <button
          className="annotation-primary-button"
          type="button"
          disabled={locked || !trimmed}
          onClick={() => onSave(trimmed)}
        >
          {state.mode === "edit" ? "保存" : "添加"}
        </button>
      </div>
    </div>,
    document.body,
  );
}

function AnnotationBubble({
  annotation,
  expanded,
  locked,
  onToggle,
  onEdit,
  onDelete,
  register,
}: {
  annotation: AnnotationRecord;
  expanded: boolean;
  locked: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  register: (element: HTMLElement | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <article ref={register} className={`annotation-bubble${expanded ? " is-expanded" : ""}`}>
      <button
        className="annotation-bubble-body"
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? "收起批注" : "展开批注"}
        onClick={onToggle}
      >
        {!expanded && <span className="annotation-bubble-note">{annotation.note}</span>}
        {annotation.note.length > 56 && (
          <ChevronDown className="annotation-bubble-chevron" size={13} aria-hidden="true" />
        )}
      </button>
      {expanded && (
        <div
          ref={scrollRef}
          className="annotation-bubble-scroll floating-scrollbar-target"
          id={`annotation-bubble-scroll-${annotation.id}`}
        >
          <p>{annotation.note}</p>
        </div>
      )}
      {expanded && (
        <FloatingScrollbar
          scrollTargetRef={scrollRef}
          controlsId={`annotation-bubble-scroll-${annotation.id}`}
          ariaLabel="批注内容滚动条"
          placement="right"
        />
      )}
      {!locked && (
        <div className="annotation-bubble-actions">
          <button
            className="annotation-icon-button"
            type="button"
            aria-label="编辑批注"
            onClick={onEdit}
          >
            <Pencil size={13} />
          </button>
          <button
            className="annotation-icon-button is-danger"
            type="button"
            aria-label="删除批注"
            onClick={onDelete}
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </article>
  );
}

function CompactAnnotationCard({
  annotation,
  point,
  mobile,
  locked,
  onEdit,
  onDelete,
  onClose,
}: {
  annotation: AnnotationRecord;
  point: SelectionPoint;
  mobile: boolean;
  locked: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => clampPopupPoint(point.left + 14, point.top - 8));

  useLayoutEffect(() => {
    if (mobile) return;
    setPosition(clampPopupPoint(point.left + 14, point.top - 8));
  }, [mobile, point.left, point.top]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", keydown, true);
    };
  }, [onClose]);

  return createPortal(
    <>
      <div
        ref={rootRef}
        className={`annotation-compact-card${mobile ? " annotation-compact-card--sheet" : ""}`}
        style={mobile ? undefined : position}
        role="dialog"
        aria-modal="true"
        aria-label="批注"
      >
        <div className="annotation-compact-heading">
          <span>批注</span>
          <button
            className="annotation-icon-button"
            type="button"
            aria-label="关闭批注"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        <div
          ref={scrollRef}
          className="annotation-compact-scroll floating-scrollbar-target"
          id={`annotation-compact-scroll-${annotation.id}`}
        >
          <p className="annotation-compact-note">{annotation.note}</p>
        </div>
        <FloatingScrollbar
          scrollTargetRef={scrollRef}
          controlsId={`annotation-compact-scroll-${annotation.id}`}
          ariaLabel="批注内容滚动条"
          placement="right"
        />
        {!locked && (
          <div className="annotation-compact-actions">
            <button className="annotation-text-button" type="button" onClick={onEdit}>
              <Pencil size={13} /> 编辑
            </button>
            <button className="annotation-text-button is-danger" type="button" onClick={onDelete}>
              <Trash2 size={13} /> 删除
            </button>
          </div>
        )}
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
  locked,
  mobile,
  onToggle,
  onEdit,
  onDelete,
}: {
  editor: Editor;
  scrollRef: RefObject<HTMLDivElement | null>;
  annotations: AnnotationRecord[];
  railVisible: boolean;
  expandedId: string | null;
  locked: boolean;
  mobile: boolean;
  onToggle: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const pinRefs = useRef(new Map<string, HTMLButtonElement>());
  const bubbleRefs = useRef(new Map<string, HTMLElement>());
  const [compact, setCompact] = useState<CompactState | null>(null);

  const updatePositions = useCallback(() => {
    const layer = layerRef.current;
    if (!layer || editor.isDestroyed) return;
    const layerRect = layer.getBoundingClientRect();
    const documentElement = editor.view.dom.closest<HTMLElement>(".editor-document");
    const documentRect = documentElement?.getBoundingClientRect();
    const bubbleWidth = 208;
    const visible: Array<{ id: string; top: number }> = [];

    for (const annotation of annotations) {
      const pin = pinRefs.current.get(annotation.id);
      if (!pin) continue;
      let coords: ReturnType<Editor["view"]["coordsAtPos"]>;
      try {
        coords = editor.view.coordsAtPos(annotation.to);
      } catch {
        pin.style.visibility = "hidden";
        continue;
      }
      const pinTop = coords.bottom - layerRect.top - 3;
      const isVisible = coords.bottom > layerRect.top - 6 && coords.top < layerRect.bottom + 6;
      pin.style.visibility = isVisible ? "visible" : "hidden";
      pin.style.left = `${Math.round(coords.right - layerRect.left + 2)}px`;
      pin.style.top = `${Math.round(pinTop - 12)}px`;
      if (isVisible) visible.push({ id: annotation.id, top: pinTop });
    }

    if (!railVisible) return;
    visible.sort((left, right) => left.top - right.top);
    let previousBottom = 10;
    const positioned: Array<{ id: string; top: number; height: number }> = [];
    for (const item of visible) {
      const bubble = bubbleRefs.current.get(item.id);
      if (!bubble) continue;
      const height = bubble.offsetHeight;
      const desired = Math.max(10, item.top - 7);
      const top = Math.max(desired, previousBottom + 9);
      positioned.push({ id: item.id, top, height });
      previousBottom = top + height;
    }
    const maximumBottom = layerRect.height - 10;
    let nextTop = maximumBottom;
    for (let index = positioned.length - 1; index >= 0; index -= 1) {
      const item = positioned[index]!;
      item.top = Math.min(item.top, nextTop - item.height);
      nextTop = item.top - 9;
    }
    const bubbleLeft = Math.min(
      layerRect.width - bubbleWidth - 10,
      Math.max(
        8,
        (documentRect?.right ?? layerRect.left + layerRect.width - 300) - layerRect.left + 20,
      ),
    );
    for (const item of positioned) {
      const bubble = bubbleRefs.current.get(item.id);
      if (!bubble) continue;
      bubble.style.visibility = item.top + item.height <= maximumBottom + 1 ? "visible" : "hidden";
      bubble.style.left = `${Math.round(bubbleLeft)}px`;
      bubble.style.top = `${Math.round(Math.max(10, item.top))}px`;
    }
  }, [annotations, editor, railVisible]);

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
    const scroll = scrollRef.current;
    scroll?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    if (scroll) observer.observe(scroll);
    observer.observe(editor.view.dom);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroll?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [editor, expandedId, scrollRef, updatePositions]);

  const compactAnnotation = compact
    ? (annotations.find((annotation) => annotation.id === compact.id) ?? null)
    : null;

  return (
    <>
      <div ref={layerRef} className="annotation-layer" role="complementary" aria-label="批注">
        {annotations.map((annotation) => (
          <button
            key={`pin-${annotation.id}`}
            ref={(element) => {
              if (element) pinRefs.current.set(annotation.id, element);
              else pinRefs.current.delete(annotation.id);
            }}
            className="annotation-pin"
            type="button"
            aria-label={`查看批注：${annotation.note.slice(0, 32)}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (railVisible) onToggle(annotation.id);
              else {
                const rect = event.currentTarget.getBoundingClientRect();
                setCompact({ id: annotation.id, point: { left: rect.right, top: rect.top } });
              }
            }}
          >
            <span aria-hidden="true" />
          </button>
        ))}
        {railVisible &&
          annotations.map((annotation) => (
            <AnnotationBubble
              key={`bubble-${annotation.id}`}
              annotation={annotation}
              expanded={expandedId === annotation.id}
              locked={locked}
              onToggle={() => onToggle(annotation.id)}
              onEdit={() => onEdit(annotation.id)}
              onDelete={() => onDelete(annotation.id)}
              register={(element) => {
                if (element) bubbleRefs.current.set(annotation.id, element);
                else bubbleRefs.current.delete(annotation.id);
              }}
            />
          ))}
      </div>
      {compactAnnotation && compact && (
        <CompactAnnotationCard
          annotation={compactAnnotation}
          point={compact.point}
          mobile={mobile}
          locked={locked}
          onEdit={() => {
            setCompact(null);
            onEdit(compactAnnotation.id);
          }}
          onDelete={() => {
            setCompact(null);
            onDelete(compactAnnotation.id);
          }}
          onClose={() => setCompact(null)}
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
  mobile,
}: {
  editor: Editor | null;
  noteId: string;
  contentVersion: number;
  locked: boolean;
  deleted: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  mobile: boolean;
}) {
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [wideEnough, setWideEnough] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;

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
    editor.on("transaction", schedule);
    editor.on("update", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      editor.off("transaction", schedule);
      editor.off("update", schedule);
    };
  }, [editor, refresh]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setWideEnough(!mobile && element.clientWidth >= 800);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mobile, scrollRef]);

  useEffect(() => {
    if (locked || deleted) setComposer(null);
  }, [deleted, locked]);

  const openCreate = useCallback(
    (from: number, to: number) => {
      if (!editor || editor.isDestroyed || locked || deleted || from >= to) return;
      setComposer({
        mode: "create",
        id: createUuid(),
        note: "",
        from,
        to,
        doc: editor.state.doc,
        noteId,
        point: selectionPoint(editor, to),
      });
    },
    [deleted, editor, locked, noteId],
  );

  const openEdit = useCallback(
    (id: string) => {
      if (!editor || editor.isDestroyed || locked || deleted) return;
      const annotation = annotationsRef.current.find((candidate) => candidate.id === id);
      if (!annotation) return;
      setComposer({
        mode: "edit",
        id,
        note: annotation.note,
        from: annotation.from,
        to: annotation.to,
        doc: editor.state.doc,
        noteId,
        point: selectionPoint(editor, annotation.to),
      });
    },
    [deleted, editor, locked, noteId],
  );

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
    },
    [deleted, editor, locked],
  );

  const deleteAnnotation = useCallback(
    (id: string) => deleteAnnotations([id]),
    [deleteAnnotations],
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
      let transaction = editor.state.tr;
      const mark = markType.create({ id: composer.id, note });
      if (composer.mode === "create") {
        if (composer.from < 0 || composer.to > transaction.doc.content.size) {
          setComposer(null);
          return;
        }
        transaction = transaction.addMark(composer.from, composer.to, mark);
      } else {
        const ranges = findAnnotationRanges(transaction.doc, composer.id);
        if (!ranges.length) {
          setComposer(null);
          return;
        }
        for (const range of ranges) transaction = transaction.addMark(range.from, range.to, mark);
      }
      editor.view.dispatch(transaction.scrollIntoView());
      setComposer(null);
      requestAnimationFrame(refresh);
    },
    [composer, deleted, editor, locked, noteId, refresh],
  );

  const closeComposer = useCallback(() => setComposer(null), []);
  const toggleExpanded = useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);
  const railVisible = wideEnough && annotations.length > 0;

  const overlay =
    editor && annotations.length > 0 ? (
      <AnnotationLayer
        editor={editor}
        scrollRef={scrollRef}
        annotations={annotations}
        railVisible={railVisible}
        expandedId={expandedId}
        locked={locked || deleted}
        mobile={mobile}
        onToggle={toggleExpanded}
        onEdit={openEdit}
        onDelete={deleteAnnotation}
      />
    ) : null;

  const composerNode = composer ? (
    <AnnotationComposer
      state={composer}
      mobile={mobile}
      locked={locked || deleted}
      onSave={saveComposer}
      onDelete={
        composer.mode === "edit"
          ? () => {
              deleteAnnotation(composer.id);
              setComposer(null);
            }
          : null
      }
      onClose={closeComposer}
    />
  ) : null;

  return {
    overlay,
    composer: composerNode,
    railVisible,
    annotations,
    openCreate,
    openEdit,
    deleteAnnotation,
    deleteAnnotations,
  };
}
