import { startTransition, type Dispatch, type SetStateAction } from "react";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { buildOutlineItems, type EditorStats, type OutlineItem } from "../editor-metrics";
import {
  getEditorDocumentTextSnapshot,
  updateEditorDocumentText,
  type EditorTextBlockStatsCache,
  type EditorTextStatsSnapshot,
} from "../editor-text-stats";

type Ref<T> = { current: T };
const OUTLINE_HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
const EDITOR_SYNC_DEBOUNCE_MS = 180;
const EDITOR_SYNC_MAX_WAIT_MS = 720;

export function useEditorSurfaceSync({
  editorTextStatsSnapshotRef,
  editorTextBlockStatsRef,
  setEditorStats,
  outlineHeadingElementsRef,
  onOutlineItemsChange,
  syncOutlineDirtyRef,
  syncFrameRef,
  syncStartedAtRef,
  composingRef,
}: {
  editorTextStatsSnapshotRef: Ref<EditorTextStatsSnapshot | null>;
  editorTextBlockStatsRef: Ref<EditorTextBlockStatsCache>;
  setEditorStats: Dispatch<SetStateAction<EditorStats>>;
  outlineHeadingElementsRef: Ref<Map<string, HTMLElement>>;
  onOutlineItemsChange: (items: OutlineItem[]) => void;
  syncOutlineDirtyRef: Ref<boolean>;
  syncFrameRef: Ref<number | null>;
  syncStartedAtRef: Ref<number | null>;
  composingRef: Ref<boolean>;
}) {
  const syncEditorSurface = (instance: Editor, syncOutline: boolean) => {
    const snapshot = getEditorDocumentTextSnapshot(
      instance.state.doc,
      editorTextStatsSnapshotRef.current,
      editorTextBlockStatsRef.current,
    );
    editorTextStatsSnapshotRef.current = snapshot;
    const nextStats = snapshot.stats;
    startTransition(() => {
      setEditorStats((current) =>
        current.wordCount === nextStats.wordCount &&
        current.characterCount === nextStats.characterCount
          ? current
          : nextStats,
      );
    });

    if (!syncOutline) return;
    const headingElements = Array.from(
      instance.view.dom.querySelectorAll<HTMLElement>(OUTLINE_HEADING_SELECTOR),
    );
    const outlineHeadingElements = headingElements.filter((element) =>
      Boolean(element.textContent?.trim()),
    );
    const generatedItems = buildOutlineItems(
      outlineHeadingElements.map((element) => ({
        level: Number(element.tagName.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6,
        title: element.textContent?.trim() ?? "",
      })),
    );
    const previousIds = new Map<HTMLElement, string>();
    for (const [id, element] of outlineHeadingElementsRef.current) previousIds.set(element, id);
    const usedIds = new Set<string>();
    const nextItems = generatedItems.map((item, index) => {
      const previousId = previousIds.get(outlineHeadingElements[index]);
      const baseId = previousId ?? item.id;
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
      usedIds.add(id);
      return id === item.id ? item : { ...item, id };
    });
    outlineHeadingElementsRef.current = new Map(
      nextItems.map((item, index) => [item.id, outlineHeadingElements[index]] as const),
    );
    startTransition(() => onOutlineItemsChange(nextItems));
  };
  const scheduleEditorSurfaceSync = (
    instance: Editor,
    outlineMayHaveChanged = true,
    transaction?: Transaction,
  ) => {
    if (transaction) {
      editorTextStatsSnapshotRef.current = updateEditorDocumentText(
        transaction,
        editorTextStatsSnapshotRef.current,
        editorTextBlockStatsRef.current,
      );
    } else if (editorTextStatsSnapshotRef.current?.doc !== instance.state.doc) {
      editorTextStatsSnapshotRef.current = getEditorDocumentTextSnapshot(
        instance.state.doc,
        editorTextStatsSnapshotRef.current,
        editorTextBlockStatsRef.current,
      );
    }
    syncOutlineDirtyRef.current ||= outlineMayHaveChanged;
    if (syncFrameRef.current !== null) {
      window.clearTimeout(syncFrameRef.current);
    }
    const now = performance.now();
    const startedAt = syncStartedAtRef.current ?? now;
    syncStartedAtRef.current = startedAt;
    const wait = Math.min(
      EDITOR_SYNC_DEBOUNCE_MS,
      Math.max(0, startedAt + EDITOR_SYNC_MAX_WAIT_MS - now),
    );
    const run = () => {
      syncFrameRef.current = null;
      syncStartedAtRef.current = null;
      if (instance.isDestroyed || instance.view.composing || composingRef.current) return;
      const syncOutline = syncOutlineDirtyRef.current;
      syncOutlineDirtyRef.current = false;
      syncEditorSurface(instance, syncOutline);
    };
    syncFrameRef.current = window.setTimeout(run, wait);
  };

  return scheduleEditorSurfaceSync;
}
