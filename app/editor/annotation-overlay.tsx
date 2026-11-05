import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ChevronDown, Pencil, Trash2, X } from "lucide-react";
import { createUuid } from "../uuid";
import { FloatingScrollbar } from "../floating-scrollbar";
import {
  collectAnnotations,
  findAnnotationRanges,
  type AnnotationRecord,
} from "./highlight-annotation";

type SelectionPoint = { left: number; top: number };

type ComposerState = {
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

function AnnotationNoteEditor({
  fieldId,
  note: initialNote,
  locked,
  saveLabel,
  onSave,
  onCancel,
  onDelete,
}: {
  fieldId: string;
  note: string;
  locked: boolean;
  saveLabel: string;
  onSave: (note: string) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState(initialNote);
  const trimmed = note.trim();

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  const submit = () => {
    if (locked || !trimmed) return;
    onSave(trimmed);
  };

  return (
    <>
      <label className="visually-hidden" htmlFor={fieldId}>
        批注内容
      </label>
      <textarea
        ref={fieldRef}
        id={fieldId}
        className="annotation-note-editor-field"
        value={note}
        rows={3}
        disabled={locked}
        placeholder="写下批注……"
        onChange={(event) => setNote(event.target.value)}
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
            submit();
          }
        }}
      />
      <div className="annotation-editor-actions">
        {onDelete && !locked && (
          <button
            className="annotation-icon-button is-danger"
            type="button"
            aria-label="删除批注"
            onClick={onDelete}
          >
            <Trash2 size={14} />
          </button>
        )}
        <span className="annotation-composer-spacer" />
        <button className="annotation-text-button" type="button" onClick={onCancel}>
          取消
        </button>
        <button
          className="annotation-primary-button"
          type="button"
          disabled={locked || !trimmed}
          onClick={submit}
        >
          {saveLabel}
        </button>
      </div>
    </>
  );
}

function AnnotationComposer({
  state,
  mobile,
  locked,
  onSave,
  onClose,
}: {
  state: ComposerState;
  mobile: boolean;
  locked: boolean;
  onSave: (note: string) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() =>
    clampPopupPoint(state.point.left, state.point.top),
  );

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
      {mobile && <div className="annotation-sheet-backdrop" aria-hidden="true" />}
      <div
        ref={rootRef}
        className={`annotation-composer${mobile ? " annotation-composer--sheet" : ""}`}
        style={mobile ? undefined : position}
        role="dialog"
        aria-modal="true"
        aria-label="添加批注"
      >
        <AnnotationNoteEditor
          fieldId={`annotation-note-${state.id}`}
          note={state.note}
          locked={locked}
          saveLabel="添加"
          onSave={onSave}
          onCancel={onClose}
        />
      </div>
    </>,
    document.body,
  );
}

function AnnotationBubble({
  annotation,
  expanded,
  editing,
  locked,
  onToggle,
  onStartEdit,
  onFinishEdit,
  onSaveNote,
  onDelete,
  register,
}: {
  annotation: AnnotationRecord;
  expanded: boolean;
  editing: boolean;
  locked: boolean;
  onToggle: () => void;
  onStartEdit: () => void;
  onFinishEdit: () => void;
  onSaveNote: (note: string) => void;
  onDelete: () => void;
  register: (element: HTMLElement | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canExpand = annotation.note.length > 56 || annotation.note.includes("\n");
  const isExpanded = expanded && canExpand && !editing;
  useEffect(() => {
    if (!isExpanded && scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [annotation.note, isExpanded]);
  return (
    <article
      ref={register}
      className={`annotation-bubble${isExpanded ? " is-expanded" : ""}${editing ? " is-editing" : ""}`}
      onClick={(event) => {
        if (editing || !canExpand || isExpanded) return;
        if ((event.target as Element).closest("button")) return;
        onToggle();
      }}
    >
      {!editing && (canExpand || !locked) && (
        <div className="annotation-card-tools">
          {canExpand && (
            <button
              className="annotation-icon-button"
              type="button"
              aria-expanded={isExpanded}
              aria-label={isExpanded ? "收起批注" : "展开批注"}
              onClick={onToggle}
            >
              <ChevronDown className="annotation-bubble-chevron" size={13} aria-hidden="true" />
            </button>
          )}
          {!locked && (
            <button
              className="annotation-icon-button"
              type="button"
              aria-label="编辑批注"
              onClick={onStartEdit}
            >
              <Pencil size={13} />
            </button>
          )}
          {!locked && (
            <button
              className="annotation-icon-button is-danger"
              type="button"
              aria-label="删除批注"
              onClick={onDelete}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      )}
      {editing ? (
        <AnnotationNoteEditor
          fieldId={`annotation-inline-${annotation.id}`}
          note={annotation.note}
          locked={locked}
          saveLabel="保存"
          onSave={(note) => {
            onSaveNote(note);
            onFinishEdit();
          }}
          onCancel={onFinishEdit}
          onDelete={onDelete}
        />
      ) : (
        <div
          ref={scrollRef}
          className="annotation-bubble-scroll floating-scrollbar-target"
          id={`annotation-bubble-scroll-${annotation.id}`}
          tabIndex={isExpanded ? 0 : undefined}
        >
          <p>{annotation.note}</p>
        </div>
      )}
      {isExpanded && !editing && (
        <FloatingScrollbar
          scrollTargetRef={scrollRef}
          controlsId={`annotation-bubble-scroll-${annotation.id}`}
          ariaLabel="批注内容滚动条"
          placement="right"
        />
      )}
    </article>
  );
}

function CompactAnnotationCard({
  annotation,
  point,
  mobile,
  locked,
  editing,
  onStartEdit,
  onFinishEdit,
  onSaveNote,
  onDelete,
  onClose,
}: {
  annotation: AnnotationRecord;
  point: SelectionPoint;
  mobile: boolean;
  locked: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onFinishEdit: () => void;
  onSaveNote: (note: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => clampPopupPoint(point.left + 14, point.top - 8));

  useLayoutEffect(() => {
    if (mobile) return;
    setPosition(clampPopupPoint(point.left + 14, point.top - 8));
  }, [mobile, point.left, point.top]);

  useEffect(() => {
    if (!editing) closeRef.current?.focus({ preventScroll: true });
  }, [editing]);

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
        className={`annotation-compact-card${mobile ? " annotation-compact-card--sheet" : ""}${editing ? " is-editing" : ""}`}
        style={mobile ? undefined : position}
        role="dialog"
        aria-modal="true"
        aria-label="批注"
      >
        {!editing && (
          <div className="annotation-card-tools">
            {!locked && (
              <button
                className="annotation-icon-button"
                type="button"
                aria-label="编辑批注"
                onClick={onStartEdit}
              >
                <Pencil size={13} />
              </button>
            )}
            {!locked && (
              <button
                className="annotation-icon-button is-danger"
                type="button"
                aria-label="删除批注"
                onClick={onDelete}
              >
                <Trash2 size={13} />
              </button>
            )}
            <button
              ref={closeRef}
              className="annotation-icon-button"
              type="button"
              aria-label="关闭批注"
              onClick={onClose}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {editing ? (
          <AnnotationNoteEditor
            fieldId={`annotation-inline-${annotation.id}`}
            note={annotation.note}
            locked={locked}
            saveLabel="保存"
            onSave={(note) => {
              onSaveNote(note);
              onFinishEdit();
            }}
            onCancel={onFinishEdit}
            onDelete={onDelete}
          />
        ) : (
          <div
            ref={scrollRef}
            className="annotation-compact-scroll floating-scrollbar-target"
            id={`annotation-compact-scroll-${annotation.id}`}
          >
            <p className="annotation-compact-note">{annotation.note}</p>
          </div>
        )}
        {!editing && (
          <FloatingScrollbar
            scrollTargetRef={scrollRef}
            controlsId={`annotation-compact-scroll-${annotation.id}`}
            ariaLabel="批注内容滚动条"
            placement="right"
          />
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
  editId,
  locked,
  mobile,
  onToggle,
  onStartEdit,
  onFinishEdit,
  onSaveNote,
  onDelete,
}: {
  editor: Editor;
  scrollRef: RefObject<HTMLDivElement | null>;
  annotations: AnnotationRecord[];
  railVisible: boolean;
  expandedId: string | null;
  editId: string | null;
  locked: boolean;
  mobile: boolean;
  onToggle: (id: string) => void;
  onStartEdit: (id: string) => void;
  onFinishEdit: () => void;
  onSaveNote: (id: string, note: string) => void;
  onDelete: (id: string) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const pinRefs = useRef(new Map<string, HTMLButtonElement>());
  const bubbleRefs = useRef(new Map<string, HTMLElement>());
  const [compact, setCompact] = useState<CompactState | null>(null);
  const [railFits, setRailFits] = useState(railVisible);
  const showRail = railVisible && railFits;

  const updatePositions = useCallback(() => {
    const layer = layerRef.current;
    if (!layer || editor.isDestroyed) return;
    const layerRect = layer.getBoundingClientRect();
    const documentElement = editor.view.dom.closest<HTMLElement>(".editor-document");
    const documentRect = documentElement?.getBoundingClientRect();
    const bubbleWidth = 208;
    if (documentRect) {
      const fits = layerRect.right - documentRect.right >= bubbleWidth + 30;
      setRailFits((current) => (current === fits ? current : fits));
    }
    const visible: Array<{ id: string; anchor: number }> = [];
    const lastRects = new Map<string, DOMRect>();

    for (const mark of editor.view.dom.querySelectorAll<HTMLElement>(
      ".note-annotation[data-annotation-id]",
    )) {
      const id = mark.dataset.annotationId;
      if (!id) continue;
      const range = document.createRange();
      range.selectNodeContents(mark);
      const rects = range.getClientRects();
      const rect = rects[rects.length - 1];
      if (rect) lastRects.set(id, rect);
    }

    for (const annotation of annotations) {
      const pin = pinRefs.current.get(annotation.id);
      if (!pin) continue;
      let rect = lastRects.get(annotation.id);
      if (!rect) {
        try {
          const coords = editor.view.coordsAtPos(annotation.to);
          rect = new DOMRect(
            coords.left,
            coords.top,
            coords.right - coords.left,
            coords.bottom - coords.top,
          );
        } catch {
          pin.style.visibility = "hidden";
          continue;
        }
      }
      const anchor = rect.top - layerRect.top - 4;
      const isVisible = rect.bottom > layerRect.top - 6 && rect.top < layerRect.bottom + 6;
      pin.style.visibility = isVisible ? "visible" : "hidden";
      pin.style.left = `${Math.round(rect.right - layerRect.left - 4)}px`;
      pin.style.top = `${Math.round(anchor - 9)}px`;
      if (isVisible) visible.push({ id: annotation.id, anchor });
    }

    if (!showRail) return;
    visible.sort((left, right) => left.anchor - right.anchor);
    let previousBottom = 10;
    const positioned: Array<{ id: string; top: number; height: number; anchor: number }> = [];
    for (const item of visible) {
      const bubble = bubbleRefs.current.get(item.id);
      if (!bubble) continue;
      const height = bubble.offsetHeight;
      const desired = Math.max(10, item.anchor - 12);
      const top = Math.max(desired, previousBottom + 9);
      positioned.push({ id: item.id, top, height, anchor: item.anchor });
      previousBottom = top + height;
    }
    const maximumBottom = layerRect.height - 10;
    let nextTop = maximumBottom;
    for (let index = positioned.length - 1; index >= 0; index -= 1) {
      const item = positioned[index]!;
      item.top = Math.min(item.top, nextTop - item.height);
      nextTop = item.top - 9;
    }
    const bubbleLeft = Math.max(
      8,
      Math.min(
        layerRect.width - bubbleWidth - 10,
        (documentRect?.right ?? layerRect.right - 248) - layerRect.left + 20,
      ),
    );
    for (const item of positioned) {
      const bubble = bubbleRefs.current.get(item.id);
      if (!bubble) continue;
      bubble.style.visibility = item.top + item.height <= maximumBottom + 1 ? "visible" : "hidden";
      bubble.style.left = `${Math.round(bubbleLeft)}px`;
      const top = Math.max(10, item.top);
      bubble.style.top = `${Math.round(top)}px`;
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
    const scroll = scrollRef.current;
    scroll?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    if (scroll) observer.observe(scroll);
    observer.observe(editor.view.dom);
    const documentElement = editor.view.dom.closest(".editor-document");
    if (documentElement) observer.observe(documentElement);
    for (const bubble of bubbleRefs.current.values()) observer.observe(bubble);
    const panel = editor.view.dom.closest(".editor-panel");
    const mutations = new MutationObserver(schedule);
    if (panel) mutations.observe(panel, { attributes: true, attributeFilter: ["class"] });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroll?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [editor, expandedId, railFits, scrollRef, updatePositions]);

  const compactAnnotation = compact
    ? (annotations.find((annotation) => annotation.id === compact.id) ?? null)
    : null;

  useEffect(() => {
    if (showRail) {
      setCompact(null);
      return;
    }
    if (!expandedId) {
      setCompact(null);
      return;
    }
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const pin = pinRefs.current.get(expandedId);
        if (!pin || getComputedStyle(pin).visibility === "hidden") return;
        const rect = pin.getBoundingClientRect();
        setCompact({ id: expandedId, point: { left: rect.right, top: rect.top } });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [annotations, expandedId, showRail]);

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
              onToggle(annotation.id);
            }}
          >
            <span aria-hidden="true" />
          </button>
        ))}
        {showRail &&
          annotations.map((annotation) => (
            <AnnotationBubble
              key={`bubble-${annotation.id}`}
              annotation={annotation}
              expanded={expandedId === annotation.id}
              editing={editId === annotation.id}
              locked={locked}
              onToggle={() => onToggle(annotation.id)}
              onStartEdit={() => onStartEdit(annotation.id)}
              onFinishEdit={onFinishEdit}
              onSaveNote={(note) => onSaveNote(annotation.id, note)}
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
          editing={editId === compactAnnotation.id}
          onStartEdit={() => onStartEdit(compactAnnotation.id)}
          onFinishEdit={onFinishEdit}
          onSaveNote={(note) => onSaveNote(compactAnnotation.id, note)}
          onDelete={() => {
            setCompact(null);
            onDelete(compactAnnotation.id);
          }}
          onClose={() => {
            setCompact(null);
            if (expandedId === compactAnnotation.id) onToggle(compactAnnotation.id);
          }}
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
  const [editId, setEditId] = useState<string | null>(null);
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
    setEditId(null);
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
    const update = () => {
      const width = element.clientWidth;
      const documentWidth = Math.min(820, width - 96);
      setWideEnough(!mobile && (width - documentWidth) / 2 >= 238);
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
      setComposer({
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

  const startEdit = useCallback(
    (id: string) => {
      if (!editor || editor.isDestroyed || locked || deleted) return;
      const annotation = annotationsRef.current.find((candidate) => candidate.id === id);
      if (!annotation) return;
      setExpandedId(id);
      setEditId(id);
    },
    [deleted, editor, locked],
  );
  const finishEdit = useCallback(() => setEditId(null), []);

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
      setComposer(null);
      setExpandedId(composer.id);
      setEditId(null);
      requestAnimationFrame(refresh);
    },
    [composer, deleted, editor, locked, noteId, refresh],
  );

  const closeComposer = useCallback(() => setComposer(null), []);
  const toggleExpanded = useCallback((id: string) => {
    setEditId(null);
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
        editId={editId}
        locked={locked || deleted}
        mobile={mobile}
        onToggle={toggleExpanded}
        onStartEdit={startEdit}
        onFinishEdit={finishEdit}
        onSaveNote={saveAnnotationNote}
        onDelete={deleteAnnotation}
      />
    ) : null;

  const composerNode = composer ? (
    <AnnotationComposer
      state={composer}
      mobile={mobile}
      locked={locked || deleted}
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
  };
}
