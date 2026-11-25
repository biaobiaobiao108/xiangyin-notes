import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { createUuid } from "../uuid";
import {
  AnnotationComposer,
  AnnotationLayer,
  RAIL_CARD_WIDTH,
  type ComposerState,
  type SelectionPoint,
} from "./annotation-cards";
import {
  collectAnnotations,
  findAnnotationRanges,
  type AnnotationRecord,
} from "./highlight-annotation";

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
