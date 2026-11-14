import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import {
  cycleSearchMatchIndex,
  findTextMatches,
  findEditorReplaceMatches,
  replaceEditorSearchMatches,
  searchHighlightPluginKey,
} from "../editor-search";

type SearchNavigation = {
  activeIndex: number;
  matchCount: number;
  totalMatchCount: number;
};

type ReplaceRequest = { noteId: string; token: number; query: string } | null;

type UseEditorSearchOptions = {
  editor: Editor | null;
  noteId: string;
  title: string;
  searchQuery: string;
  searchNavigationToken: number;
  reloadToken: number;
  replaceRequest: ReplaceRequest;
  onReplaceRequestHandled?: (token: number) => void;
  isLoading: boolean;
  editorLocked: boolean;
  isMobileViewport: boolean;
  editorScrollRef: RefObject<HTMLDivElement | null>;
  titleInputRef: RefObject<HTMLTextAreaElement | null>;
  onClearSearch?: () => void;
};

export function useEditorSearch({
  editor,
  noteId,
  title,
  searchQuery,
  searchNavigationToken,
  reloadToken,
  replaceRequest,
  onReplaceRequestHandled,
  isLoading,
  editorLocked,
  isMobileViewport,
  editorScrollRef,
  titleInputRef,
  onClearSearch,
}: UseEditorSearchOptions) {
  const [searchNavigation, setSearchNavigation] = useState<SearchNavigation>({
    activeIndex: 0,
    matchCount: 0,
    totalMatchCount: 0,
  });
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceQuery, setReplaceQuery] = useState("");
  const [replacementText, setReplacementText] = useState("");
  const effectiveSearchQuery = replaceOpen ? replaceQuery : searchQuery;
  const searchQueryRef = useRef(effectiveSearchQuery);
  const searchNavigationRef = useRef(searchNavigation);

  useEffect(() => {
    searchQueryRef.current = effectiveSearchQuery;
    searchNavigationRef.current = searchNavigation;
  });

  const syncSearchNavigation = useCallback((instance: Editor) => {
    const state = searchHighlightPluginKey.getState(instance.state);
    const next = {
      activeIndex: state?.activeIndex ?? 0,
      matchCount: state?.matches.length ?? 0,
      totalMatchCount: state?.totalMatchCount ?? 0,
    };
    setSearchNavigation((current) =>
      current.activeIndex === next.activeIndex &&
      current.matchCount === next.matchCount &&
      current.totalMatchCount === next.totalMatchCount
        ? current
        : next,
    );
  }, []);

  const scrollToActiveSearchMatch = useCallback(() => {
    if (!editor || editor.isDestroyed) return;
    const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth";
    editor.view.dom
      .querySelector<HTMLElement>(".editor-search-match--active")
      ?.scrollIntoView({ behavior, block: "center", inline: "nearest" });
  }, [editor]);

  const moveSearchMatch = useCallback(
    (direction: -1 | 1) => {
      if (!editor || isLoading || !searchQueryRef.current) return;
      const state = searchHighlightPluginKey.getState(editor.state);
      if (!state?.matches.length) return;
      const nextIndex = cycleSearchMatchIndex(state.activeIndex, state.matches.length, direction);
      editor.view.dispatch(
        editor.state.tr.setMeta(searchHighlightPluginKey, {
          type: "activeIndex",
          index: nextIndex,
        }),
      );
      requestAnimationFrame(scrollToActiveSearchMatch);
    },
    [editor, isLoading, scrollToActiveSearchMatch],
  );

  const closeReplace = useCallback(() => {
    setReplaceOpen(false);
    editor?.commands.focus();
  }, [editor]);

  const replaceCurrent = useCallback(() => {
    if (!editor || !editor.isEditable || editorLocked || !replaceQuery) return;
    const search = searchHighlightPluginKey.getState(editor.state);
    const match = search?.matches[search.activeIndex];
    if (!match) return;
    const transaction = editor.state.tr.insertText(replacementText, match.from, match.to);
    const matches = findEditorReplaceMatches(transaction.doc, replaceQuery);
    const nextPosition = match.from + replacementText.length;
    const nextIndex = matches.findIndex((item) => item.from >= nextPosition);
    transaction.setMeta(searchHighlightPluginKey, {
      type: "query",
      query: replaceQuery,
      literal: true,
      activeIndex: nextIndex < 0 ? 0 : nextIndex,
    });
    editor.view.dispatch(closeHistory(transaction));
    editor.view.dispatch(closeHistory(editor.state.tr));
    requestAnimationFrame(scrollToActiveSearchMatch);
  }, [editor, editorLocked, replaceQuery, replacementText, scrollToActiveSearchMatch]);

  const replaceAll = useCallback(() => {
    if (!editor || !editor.isEditable || editorLocked || !replaceQuery) return;
    const { transaction, count } = replaceEditorSearchMatches(
      editor.state,
      replaceQuery,
      replacementText,
    );
    if (!count) return;
    editor.view.dispatch(closeHistory(transaction));
    editor.view.dispatch(closeHistory(editor.state.tr));
  }, [editor, editorLocked, replaceQuery, replacementText]);

  const toggleReplace = useCallback(() => {
    if (replaceOpen) setReplaceOpen(false);
    else {
      setReplaceQuery(searchQuery);
      setReplacementText("");
      setReplaceOpen(true);
    }
  }, [replaceOpen, searchQuery]);

  useEffect(() => {
    if (!searchQuery) setReplaceOpen(false);
  }, [searchQuery]);

  useEffect(() => {
    if (!editor || !replaceRequest || replaceRequest.noteId !== noteId) return;
    setReplaceQuery((current) => replaceRequest.query || (replaceOpen ? current : searchQuery));
    setReplaceOpen(true);
    const frame = requestAnimationFrame(() => {
      const input = editor.view.dom
        .closest(".editor-panel")
        ?.querySelector<HTMLInputElement>(".editor-replace-field input[type=search]");
      input?.focus();
      input?.select();
      onReplaceRequestHandled?.(replaceRequest.token);
    });
    return () => cancelAnimationFrame(frame);
  }, [editor, noteId, replaceRequest, onReplaceRequestHandled]);

  useEffect(() => {
    if (!replaceOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      if (event.target instanceof Element && event.target.closest("dialog[open], [role='dialog']"))
        return;
      const panel = editor?.view.dom.closest(".editor-panel");
      if (!(event.target instanceof Node) || !panel?.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeReplace();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [replaceOpen, editor, closeReplace]);

  useEffect(() => {
    if (!editor || isLoading) return;
    const trimmedQuery = replaceOpen ? replaceQuery : searchQuery.trim();
    const titleMatches = replaceOpen ? [] : findTextMatches(title, trimmedQuery);
    editor.view.dispatch(
      editor.state.tr.setMeta(searchHighlightPluginKey, {
        type: "query",
        query: trimmedQuery,
        literal: replaceOpen,
        activeIndex: 0,
      }),
    );
    syncSearchNavigation(editor);
    const hasBodyMatches =
      (searchHighlightPluginKey.getState(editor.state)?.totalMatchCount ?? 0) > 0;

    const frame = requestAnimationFrame(() => {
      if (editor.isDestroyed || replaceOpen) return;
      const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
      if (titleMatches.length > 0) {
        editorScrollRef.current?.scrollTo({ top: 0, behavior });
        const titleInput = titleInputRef.current;
        if (titleInput && !isMobileViewport) {
          titleInput.focus({ preventScroll: true });
          titleInput.setSelectionRange(titleMatches[0].start, titleMatches[0].end);
        }
        return;
      }
      if (!hasBodyMatches) return;
      editor.view.dom
        .querySelector<HTMLElement>(".editor-search-match--active")
        ?.scrollIntoView({ behavior, block: "center", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    editor,
    isLoading,
    isMobileViewport,
    noteId,
    reloadToken,
    title,
    searchQuery,
    replaceOpen,
    replaceQuery,
    searchNavigationToken,
    syncSearchNavigation,
  ]);

  useEffect(() => {
    const handleSearchKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
      if (event.key === "F3") {
        if (event.defaultPrevented) return;
        if (!searchQueryRef.current.trim() || searchNavigationRef.current.totalMatchCount === 0)
          return;
        event.preventDefault();
        moveSearchMatch(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        // 搜索高亮清除作为 Escape 第 1 层由工作区统一处理，这里保留同规则兜底。
        if (searchQueryRef.current.trim() && onClearSearch) {
          event.preventDefault();
          event.stopImmediatePropagation();
          onClearSearch();
        }
      }
    };
    window.addEventListener("keydown", handleSearchKeyDown);
    return () => window.removeEventListener("keydown", handleSearchKeyDown);
  }, [moveSearchMatch, onClearSearch]);

  return {
    searchNavigation,
    replaceOpen,
    replaceQuery,
    replacementText,
    setReplaceQuery,
    setReplacementText,
    setReplaceOpen,
    syncSearchNavigation,
    moveSearchMatch,
    replaceCurrent,
    replaceAll,
    closeReplace,
    toggleReplace,
  };
}
