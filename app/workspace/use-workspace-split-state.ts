import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Note } from "../../shared/types";
import { noteMetadataSnapshot } from "./helpers";
import { DEFAULT_SPLIT_RATIO } from "./split-resizer";
import type { SaveState } from "./use-note-save-queue";
import { useOutlineState } from "./use-outline-state";

/**
 * 集中管理分屏编辑器的状态、大纲与引用，以及与分屏互斥的自动阅读模式状态。
 */
export function useWorkspaceSplitState(selectedIdRef: MutableRefObject<string | null>) {
  const [splitNoteId, setSplitNoteId] = useState<string | null>(null);
  const splitNoteIdRef = useRef<string | null>(null);
  splitNoteIdRef.current = splitNoteId;

  const [autoReadingMode, setAutoReadingMode] = useState(false);
  const toggleAutoReadingMode = useCallback(() => {
    if (splitNoteIdRef.current || !selectedIdRef.current) return;
    setAutoReadingMode((current) => !current);
  }, [selectedIdRef]);
  const exitAutoReadingMode = useCallback(() => {
    setAutoReadingMode(false);
  }, []);
  useEffect(() => {
    if (splitNoteId) setAutoReadingMode(false);
  }, [splitNoteId]);

  const closeSplitRef = useRef<() => void>(() => undefined);
  const [splitSelectedNote, setSplitSelectedNote] = useState<Note | null>(null);
  const splitSelectedRef = useRef<Note | null>(null);
  const splitNoteOpeningRef = useRef<Promise<void> | null>(null);
  const [splitIsNoteLoading, setSplitIsNoteLoading] = useState(false);
  const [splitSaveState, setSplitSaveState] = useState<SaveState>("idle");
  const [splitNoteReloadToken, setSplitNoteReloadToken] = useState(0);
  const [activePane, setActivePane] = useState<"primary" | "secondary">("primary");
  const [splitRatio, setSplitRatio] = useState(DEFAULT_SPLIT_RATIO);

  const {
    items: splitOutlineItems,
    activeId: splitActiveOutlineId,
    navigateRef: splitOutlineNavigateRef,
    onItemsChange: handleSplitOutlineItemsChange,
    onActiveChange: handleSplitOutlineActiveChange,
    onNavigationReady: handleSplitOutlineNavigationReady,
  } = useOutlineState();

  const splitLoadRequestRef = useRef(0);
  const splitAbortRef = useRef<AbortController | null>(null);
  const splitMarkdownReaderRef = useRef<((noteId: string) => string | null) | null>(null);
  const splitMarkdownDirtyNoteRef = useRef<string | null>(null);
  const [splitEditorFocusNoteId, setSplitEditorFocusNoteId] = useState<string | null>(null);
  const handleSplitEditorFocus = useCallback(() => setSplitEditorFocusNoteId(null), []);
  const setSplitSelectedNoteMetadata = useCallback((note: Note | null) => {
    setSplitSelectedNote(note ? noteMetadataSnapshot(note) : null);
  }, []);
  const [splitPickerOpen, setSplitPickerOpen] = useState(false);

  return {
    splitNoteId,
    setSplitNoteId,
    splitNoteIdRef,
    autoReadingMode,
    setAutoReadingMode,
    toggleAutoReadingMode,
    exitAutoReadingMode,
    closeSplitRef,
    splitSelectedNote,
    setSplitSelectedNote,
    splitSelectedRef,
    splitNoteOpeningRef,
    splitIsNoteLoading,
    setSplitIsNoteLoading,
    splitSaveState,
    setSplitSaveState,
    splitNoteReloadToken,
    setSplitNoteReloadToken,
    activePane,
    setActivePane,
    splitRatio,
    setSplitRatio,
    splitOutlineItems,
    splitActiveOutlineId,
    splitOutlineNavigateRef,
    handleSplitOutlineItemsChange,
    handleSplitOutlineActiveChange,
    handleSplitOutlineNavigationReady,
    splitLoadRequestRef,
    splitAbortRef,
    splitMarkdownReaderRef,
    splitMarkdownDirtyNoteRef,
    splitEditorFocusNoteId,
    setSplitEditorFocusNoteId,
    handleSplitEditorFocus,
    setSplitSelectedNoteMetadata,
    splitPickerOpen,
    setSplitPickerOpen,
  };
}
