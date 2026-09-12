import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import { findWrapping } from "@tiptap/pm/transform";
import { ChevronLeft, Link2, Maximize2, Minimize2, Minus, Trash2, Undo2 } from "lucide-react";
import type { Note } from "../shared/types";
import { BrandMark } from "./brand-mark";
import { cycleSearchMatchIndex, findEditorSearchMatches, findTextMatches, searchHighlightPluginKey, SearchHighlightExtension } from "./editor-search";
import { buildOutlineItems, countEditorText, detectLeakedImePrefix, parseMarkdownBlockShortcut, shouldParseMarkdownPaste, type EditorStats, type MarkdownBlockShortcut, type OutlineItem } from "./editor-metrics";
import { FloatingScrollbar } from "./floating-scrollbar";
import { ImeMarkdownSafeExtension, imeMarkdownSafePluginKey } from "./ime-markdown-safe-extension";
import { editorCoreExtensionOptions } from "./editor/editor-config";
import { EditorFloatingTools } from "./editor/editor-panels";

type EditorWithMarkdown = Editor & { getMarkdown: () => string };

export function NoteEditor({ note, searchQuery = "", saveState, isLoading = false, reloadToken = 0, focusRequested = false, trashBusy = false, onFocusHandled, onChange, onSaveNow, onReloadNote, onShare, onToggleFavorite, onMoveToTrash, onRestore, onPermanentDelete, onOpenList, focusMode = false, onToggleFocusMode, onClearSearch }: {
  note: Note;
  searchQuery?: string;
  saveState: "idle" | "saving" | "saved" | "local" | "conflict" | "error";
  isLoading?: boolean;
  reloadToken?: number;
  focusRequested?: boolean;
  trashBusy?: boolean;
  onFocusHandled?: () => void;
  onChange: (patch: { title?: string; contentMarkdown?: string; notebookId?: string }) => void;
  onSaveNow: () => void;
  onReloadNote: () => void;
  onShare: () => void;
  onToggleFavorite: () => void;
  onMoveToTrash: () => void;
  onRestore: () => void;
  onPermanentDelete?: () => void;
  onOpenList?: () => void;
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
  onClearSearch?: () => void;
}) {

  const editorScrollRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const editorInstanceRef = useRef<Editor | null>(null);
  const floatingToolsRef = useRef<HTMLDivElement>(null);
  const outlineTriggerRef = useRef<HTMLButtonElement>(null);
  const syncFrameRef = useRef<number | null>(null);
  const composingRef = useRef(false);
  const leakedCandidateRef = useRef<{ key: string; blockStartPos: number; emptyAtStart: boolean } | null>(null);
  const imeCleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeEditorNoteIdRef = useRef(note.id);
  const initialContentRef = useRef(note.contentMarkdown);
  const onChangeRef = useRef(onChange);
  const surfaceSyncRef = useRef<(instance: Editor) => void>(() => undefined);
  const [editorStats, setEditorStats] = useState<EditorStats>(() => countEditorText(""));
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [deferredLoading, setDeferredLoading] = useState(false);
  const editorLocked = isLoading || deferredLoading;
  const [searchNavigation, setSearchNavigation] = useState({ activeIndex: 0, matchCount: 0 });
  const searchQueryRef = useRef(searchQuery);
  const searchNavigationRef = useRef(searchNavigation);
  searchQueryRef.current = searchQuery;
  searchNavigationRef.current = searchNavigation;
  onChangeRef.current = onChange;

  const syncEditorSurface = (instance: Editor) => {
    const editorText = instance.getText({ blockSeparator: "\n" });
    const nextStats = countEditorText(editorText);
    setEditorStats((current) => current.wordCount === nextStats.wordCount && current.characterCount === nextStats.characterCount ? current : nextStats);

    const headings = Array.from(instance.view.dom.querySelectorAll<HTMLElement>("h1, h2, h3"))
      .map((element) => ({ level: Number(element.tagName.slice(1)) as 1 | 2 | 3, title: element.textContent?.trim() ?? "" }))
      .filter((heading) => heading.title.length > 0);
    const nextItems = buildOutlineItems(headings);
    setOutlineItems((current) => {
      const unchanged = current.length === nextItems.length && current.every((item, index) => {
        const next = nextItems[index];
        return next && item.id === next.id && item.level === next.level && item.title === next.title;
      });
      return unchanged ? current : nextItems;
    });
  };
  const scheduleEditorSurfaceSync = (instance: Editor) => {
    if (syncFrameRef.current !== null) cancelAnimationFrame(syncFrameRef.current);
    syncFrameRef.current = requestAnimationFrame(() => {
      syncFrameRef.current = null;
      syncEditorSurface(instance);
    });
  };

  const executeBlockShortcut = (view: Editor["view"], from: number, shortcut: MarkdownBlockShortcut): boolean => {
    const $from = view.state.doc.resolve(from);
    const start = $from.start();
    const end = from;
    const tr = view.state.tr.delete(start, end);

    if (shortcut.type === "heading") {
      const headingNode = view.state.schema.nodes.heading;
      if (!headingNode) return false;
      tr.setBlockType(start, start, headingNode, { level: shortcut.level });
      tr.setMeta(imeMarkdownSafePluginKey, { type: "blockConverted", pos: start });
      view.dispatch(tr.scrollIntoView());
      return true;
    }

    if (shortcut.type === "blockquote") {
      const blockquoteNode = view.state.schema.nodes.blockquote;
      const range = tr.doc.resolve(start).blockRange();
      if (!blockquoteNode || !range) return false;
      const wrapping = findWrapping(range, blockquoteNode);
      if (!wrapping) return false;
      tr.wrap(range, wrapping);
      tr.setMeta(imeMarkdownSafePluginKey, { type: "blockConverted", pos: start });
      view.dispatch(tr.scrollIntoView());
      return true;
    }

    if (shortcut.type === "bulletList") {
      const bulletListNode = view.state.schema.nodes.bulletList;
      const range = tr.doc.resolve(start).blockRange();
      if (!bulletListNode || !range) return false;
      const wrapping = findWrapping(range, bulletListNode);
      if (!wrapping) return false;
      tr.wrap(range, wrapping);
      tr.setMeta(imeMarkdownSafePluginKey, { type: "blockConverted", pos: start });
      view.dispatch(tr.scrollIntoView());
      return true;
    }

    if (shortcut.type === "orderedList") {
      const orderedListNode = view.state.schema.nodes.orderedList;
      const range = tr.doc.resolve(start).blockRange();
      if (!orderedListNode || !range) return false;
      const wrapping = findWrapping(range, orderedListNode);
      if (!wrapping) return false;
      tr.wrap(range, wrapping);
      tr.setMeta(imeMarkdownSafePluginKey, { type: "blockConverted", pos: start });
      view.dispatch(tr.scrollIntoView());
      return true;
    }

    if (shortcut.type === "taskList") {
      const taskListNode = view.state.schema.nodes.taskList;
      const range = tr.doc.resolve(start).blockRange();
      if (!taskListNode || !range) return false;
      const wrapping = findWrapping(range, taskListNode);
      if (!wrapping) return false;
      tr.wrap(range, wrapping);
      tr.setMeta(imeMarkdownSafePluginKey, { type: "blockConverted", pos: start });
      view.dispatch(tr.scrollIntoView());
      return true;
    }

    if (shortcut.type === "codeBlock") {
      const codeBlockNode = view.state.schema.nodes.codeBlock;
      if (!codeBlockNode) return false;
      tr.setBlockType(start, start, codeBlockNode);
      tr.setMeta(imeMarkdownSafePluginKey, { type: "blockConverted", pos: start });
      view.dispatch(tr.scrollIntoView());
      return true;
    }

    return false;
  };

  const extensions = useMemo(() => [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false }),
    Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { title: "按住 Ctrl 或 ⌘ 点击打开链接" } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: "从一句话开始……" }),
    Markdown,
    ImeMarkdownSafeExtension,
    SearchHighlightExtension,
  ], []);
  const editorProps = useMemo(() => ({
    attributes: { class: "note-prose" },
    handleClick: (_view: Editor["view"], _pos: number, event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey) {
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest("a");
        if (anchor?.href) {
          window.open(anchor.href, "_blank", "noopener,noreferrer");
          return true;
        }
      }
      return false;
    },
    handlePaste: (view: Editor["view"], event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      const html = event.clipboardData?.getData("text/html") ?? "";
      if (!shouldParseMarkdownPaste(text, Boolean(html))) return false;
      const markdownManager = editorInstanceRef.current?.markdown;
      if (!markdownManager) return false;
      try {
        const parsedDocument = view.state.schema.nodeFromJSON(markdownManager.parse(text));
        const slice = parsedDocument.slice(0, parsedDocument.content.size);
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView().setMeta("uiEvent", "paste"));
        return true;
      } catch {
        return false;
      }
    },
    handleKeyDown: (view: Editor["view"], event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.key === "Process") {
        composingRef.current = true;
        if (!leakedCandidateRef.current) {
          const { $from } = view.state.selection;
          if ($from.parent.content.size === 0 || ($from.parentOffset === 0 && $from.parent.textContent.length === 0)) {
            let key = "";
            if (event.code && event.code.startsWith("Key")) {
              key = event.code.slice(3).toLowerCase();
            } else if (event.code && event.code.startsWith("Digit")) {
              key = event.code.slice(5);
            } else if (event.key && event.key.length === 1 && event.key !== "Process") {
              key = event.key.toLowerCase();
            }
            leakedCandidateRef.current = {
              key,
              blockStartPos: $from.start(),
              emptyAtStart: true,
            };
          }
        }
      }
      return false;
    },
    handleTextInput: (view: Editor["view"], from: number, to: number, text: string) => {
      if ((text !== " " && text !== "\u3000") || from !== to || composingRef.current || view.composing) return false;
      const $from = view.state.doc.resolve(from);
      if ($from.parent.type.name !== "paragraph") return false;
      const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\uFFFC");
      const shortcut = parseMarkdownBlockShortcut(`${textBefore} `);
      if (!shortcut) return false;
      return executeBlockShortcut(view, from, shortcut);
    },
    handleDOMEvents: {
      compositionstart: (view: Editor["view"]) => {
        composingRef.current = true;
        if (imeCleanupTimerRef.current !== null) {
          clearTimeout(imeCleanupTimerRef.current);
          imeCleanupTimerRef.current = null;
        }
        const { $from } = view.state.selection;
        const text = $from.parent.textContent;
        if (!leakedCandidateRef.current) {
          if ($from.parent.content.size === 0 || ($from.parentOffset === 0 && text.length === 0)) {
            leakedCandidateRef.current = {
              key: "",
              blockStartPos: $from.start(),
              emptyAtStart: true,
            };
          } else if (text.length === 1 && /^[a-zA-Z0-9]$/.test(text) && $from.parentOffset <= 1) {
            leakedCandidateRef.current = {
              key: text.toLowerCase(),
              blockStartPos: $from.start(),
              emptyAtStart: true,
            };
          }
        }
        return false;
      },
      compositionend: (view: Editor["view"], event: Event) => {
        composingRef.current = false;
        const candidate = leakedCandidateRef.current;
        const committedText = (event as CompositionEvent).data;
        if (imeCleanupTimerRef.current !== null) {
          clearTimeout(imeCleanupTimerRef.current);
          imeCleanupTimerRef.current = null;
        }
        if (candidate && candidate.emptyAtStart) {
          imeCleanupTimerRef.current = setTimeout(() => {
            imeCleanupTimerRef.current = null;
            try {
              if (!view || view.isDestroyed) return;
              const { state, dispatch } = view;
              const resolvedPos = Math.min(candidate.blockStartPos, state.doc.content.size);
              const $pos = state.doc.resolve(resolvedPos);
              const block = $pos.parent;
              const blockStart = $pos.start();
              const blockText = block.textContent;

              const leakedLen = detectLeakedImePrefix(blockText, candidate.key || null, committedText);
              if (leakedLen && leakedLen > 0) {
                const deleteFrom = blockStart;
                const deleteTo = blockStart + leakedLen;
                const tr = state.tr.delete(deleteFrom, deleteTo);
                dispatch(tr.scrollIntoView());
              }
            } finally {
              leakedCandidateRef.current = null;
            }
          }, 30);
        } else {
          leakedCandidateRef.current = null;
        }
        if (editorInstanceRef.current) {
          surfaceSyncRef.current(editorInstanceRef.current);
        }
        return false;
      },
      compositioncancel: () => {
        composingRef.current = false;
        leakedCandidateRef.current = null;
        if (imeCleanupTimerRef.current !== null) {
          clearTimeout(imeCleanupTimerRef.current);
          imeCleanupTimerRef.current = null;
        }
        if (editorInstanceRef.current) {
          surfaceSyncRef.current(editorInstanceRef.current);
        }
        return false;
      },
    },
  }), []);
  surfaceSyncRef.current = scheduleEditorSurfaceSync;

  const editor = useEditor({
    editable: !note.deletedAt && !isLoading,
    extensions,
    coreExtensionOptions: editorCoreExtensionOptions,
    content: initialContentRef.current,
    contentType: "markdown",
    editorProps,
    onUpdate: ({ editor: instance }) => {
      onChangeRef.current({ contentMarkdown: (instance as EditorWithMarkdown).getMarkdown() });
      if (instance.view.composing || composingRef.current) return;
      surfaceSyncRef.current(instance);
    },
  });

  const syncSearchNavigation = useCallback((instance: Editor) => {
    const state = searchHighlightPluginKey.getState(instance.state);
    const next = { activeIndex: state?.activeIndex ?? 0, matchCount: state?.matches.length ?? 0 };
    setSearchNavigation((current) => current.activeIndex === next.activeIndex && current.matchCount === next.matchCount ? current : next);
  }, []);

  useEffect(() => {
    editorInstanceRef.current = editor;
    return () => {
      if (editorInstanceRef.current === editor) editorInstanceRef.current = null;
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const handleTransaction = ({ editor: instance }: { editor: Editor }) => syncSearchNavigation(instance);
    editor.on("transaction", handleTransaction);
    syncSearchNavigation(editor);
    return () => { editor.off("transaction", handleTransaction); };
  }, [editor, syncSearchNavigation]);

  useEffect(() => {
    if (!editor) return;
    scheduleEditorSurfaceSync(editor);
    return () => {
      if (syncFrameRef.current !== null) cancelAnimationFrame(syncFrameRef.current);
      syncFrameRef.current = null;
      if (imeCleanupTimerRef.current !== null) clearTimeout(imeCleanupTimerRef.current);
      imeCleanupTimerRef.current = null;
      leakedCandidateRef.current = null;
      composingRef.current = false;
    };
  }, [editor]);

  useEffect(() => {
    if (!isLoading) {
      setDeferredLoading(false);
      return;
    }
    const timer = setTimeout(() => {
      setDeferredLoading(true);
    }, 150);
    return () => clearTimeout(timer);
  }, [isLoading]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!note.deletedAt && !editorLocked, false);
  }, [editor, editorLocked, note.deletedAt]);

  const appliedReloadTokenRef = useRef(reloadToken);
  useEffect(() => {
    if (!editor) return;
    const switchedNote = activeEditorNoteIdRef.current !== note.id;
    if (!switchedNote && appliedReloadTokenRef.current === reloadToken) return;
    appliedReloadTokenRef.current = reloadToken;
    activeEditorNoteIdRef.current = note.id;
    if (imeCleanupTimerRef.current !== null) clearTimeout(imeCleanupTimerRef.current);
    imeCleanupTimerRef.current = null;
    leakedCandidateRef.current = null;
    composingRef.current = false;
    setOutlineOpen(false);
    setActiveOutlineId(null);
    setOutlineItems([]);
    setEditorStats(countEditorText(""));
    editor.commands.setContent(note.contentMarkdown, { contentType: "markdown", emitUpdate: false });
    editorScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    if (switchedNote) {
      const doc = documentRef.current;
      if (doc) {
        doc.classList.remove("editor-document--entering");
        void doc.offsetWidth;
        doc.classList.add("editor-document--entering");
      }
    }
    scheduleEditorSurfaceSync(editor);
  }, [editor, note.id, reloadToken]);

  useEffect(() => {
    if (!editor || !focusRequested || isLoading || note.deletedAt) return;
    // Apply focus after the new note's content and editable state are ready.
    if (editor.commands.focus("start")) onFocusHandled?.();
  }, [editor, focusRequested, isLoading, note.id, note.deletedAt, onFocusHandled]);

  const scrollToActiveSearchMatch = useCallback(() => {
    if (!editor || editor.isDestroyed) return;
    const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    editor.view.dom.querySelector<HTMLElement>(".editor-search-match--active")?.scrollIntoView({ behavior, block: "center", inline: "nearest" });
  }, [editor]);

  const moveSearchMatch = useCallback((direction: -1 | 1) => {
    if (!editor || isLoading || !searchQueryRef.current.trim()) return;
    const state = searchHighlightPluginKey.getState(editor.state);
    if (!state?.matches.length) return;
    const nextIndex = cycleSearchMatchIndex(state.activeIndex, state.matches.length, direction);
    editor.view.dispatch(editor.state.tr.setMeta(searchHighlightPluginKey, { type: "activeIndex", index: nextIndex }));
    requestAnimationFrame(scrollToActiveSearchMatch);
  }, [editor, isLoading, scrollToActiveSearchMatch]);

  useEffect(() => {
    if (!editor || isLoading) return;
    const titleMatches = findTextMatches(note.title, searchQuery);
    const bodyMatches = findEditorSearchMatches(editor.state.doc, searchQuery);
    editor.view.dispatch(editor.state.tr.setMeta(searchHighlightPluginKey, { type: "query", query: searchQuery, activeIndex: 0 }));
    syncSearchNavigation(editor);

    const frame = requestAnimationFrame(() => {
      if (editor.isDestroyed) return;
      const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      if (titleMatches.length > 0) {
        editorScrollRef.current?.scrollTo({ top: 0, behavior });
        const titleInput = titleInputRef.current;
        if (titleInput) {
          titleInput.focus({ preventScroll: true });
          titleInput.setSelectionRange(titleMatches[0].start, titleMatches[0].end);
        }
        return;
      }
      if (!bodyMatches.length) return;
      editor.view.dom.querySelector<HTMLElement>(".editor-search-match--active")?.scrollIntoView({ behavior, block: "center", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [editor, isLoading, note.id, searchQuery, syncSearchNavigation]);

  useEffect(() => {
    const handleSearchKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
      if (event.key === "F3") {
        if (!searchQueryRef.current.trim() || searchNavigationRef.current.matchCount === 0) return;
        event.preventDefault();
        moveSearchMatch(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        if (searchQueryRef.current.trim() && searchNavigationRef.current.matchCount > 0 && onClearSearch) {
          event.preventDefault();
          onClearSearch();
        }
      }
    };
    window.addEventListener("keydown", handleSearchKeyDown);
    return () => window.removeEventListener("keydown", handleSearchKeyDown);
  }, [moveSearchMatch, onClearSearch]);


  useEffect(() => {
    if (isLoading) setOutlineOpen(false);
  }, [isLoading]);

  useEffect(() => {
    if (!outlineOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !floatingToolsRef.current?.contains(event.target)) setOutlineOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOutlineOpen(false);
      outlineTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [outlineOpen]);

  useEffect(() => {
    const root = editorScrollRef.current;
    if (!root || outlineItems.length === 0) {
      setActiveOutlineId(null);
      return;
    }

    let activeFrame: number | null = null;
    const getCurrentHeadings = () => Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3")).filter((heading) => heading.textContent?.trim());
    const updateActiveHeading = () => {
      const currentHeadings = getCurrentHeadings();
      const rootTop = root.getBoundingClientRect().top;
      const activationLine = rootTop + 32;
      let currentId: string | null = null;
      const maxScrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
      if (root.scrollTop >= maxScrollTop - 1) {
        currentId = outlineItems[outlineItems.length - 1]?.id ?? null;
      } else {
        for (const [index, item] of outlineItems.entries()) {
          const element = currentHeadings[index];
          if (element && element.getBoundingClientRect().top <= activationLine) currentId = item.id;
          else if (currentId) break;
        }
      }
      const nextId = currentId ?? outlineItems[0]?.id ?? null;
      setActiveOutlineId((current) => current === nextId ? current : nextId);
    };
    const scheduleActiveHeading = () => {
      if (activeFrame !== null) return;
      activeFrame = requestAnimationFrame(() => {
        activeFrame = null;
        updateActiveHeading();
      });
    };

    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(scheduleActiveHeading, {
      root,
      rootMargin: "-12% 0px -68% 0px",
      threshold: [0, 1],
    });
    for (const [index, element] of getCurrentHeadings().entries()) {
      if (index >= outlineItems.length) break;
      observer?.observe(element);
    }
    root.addEventListener("scroll", scheduleActiveHeading, { passive: true });
    scheduleActiveHeading();
    return () => {
      observer?.disconnect();
      root.removeEventListener("scroll", scheduleActiveHeading);
      if (activeFrame !== null) cancelAnimationFrame(activeFrame);
    };
  }, [outlineItems]);

  const scrollToOutlineItem = (id: string) => {
    const scrollRoot = editorScrollRef.current;
    const itemIndex = outlineItems.findIndex((item) => item.id === id);
    const currentHeadings = scrollRoot
      ? Array.from(scrollRoot.querySelectorAll<HTMLElement>("h1, h2, h3")).filter((heading) => heading.textContent?.trim())
      : [];
    const element = itemIndex >= 0 ? currentHeadings[itemIndex] : undefined;
    if (!element || !scrollRoot) return;
    const rootRect = scrollRoot.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const maxScrollTop = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    const targetTop = Math.min(maxScrollTop, Math.max(0, scrollRoot.scrollTop + elementRect.top - rootRect.top - 24));
    scrollRoot.scrollTo({ top: targetTop, behavior: "auto" });
    setActiveOutlineId(id);
  };

  const saveLabel = saveState === "saving" ? "保存中" : saveState === "local" ? "已保存到本机" : "已保存";
  return (
    <section className={`editor-panel ${deferredLoading ? "is-loading" : ""} ${focusMode ? "is-focus-mode" : ""}`} aria-label="笔记编辑器" aria-busy={editorLocked} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "s") { event.preventDefault(); onSaveNow(); } }}>
      <header className="editor-header">
        <div className="editor-header-start">
          {onOpenList && <button className="icon-button mobile-only editor-back" type="button" aria-label="返回笔记列表" onClick={onOpenList} disabled={editorLocked}><ChevronLeft size={20} /></button>}
          <div className="editor-meta" aria-label={`最后编辑于${relativeDate(note.updatedAt)}，${editorStats.wordCount} 字`}>
            <span>最后编辑于 {relativeDate(note.updatedAt)}</span>
            <span aria-hidden="true">·</span>
            <strong>{editorStats.wordCount} 字</strong>
          </div>
        </div>
        <div className="editor-header-title" title={note.title.trim() || "未命名笔记"} aria-label={`当前文档：${note.title.trim() || "未命名笔记"}`}>
          {note.title.trim() || "未命名笔记"}
        </div>
        <div className="editor-actions">
          {saveState === "error" ? (
            <button className="save-status save-status--error save-status--action" type="button" onClick={onSaveNow}><span className="save-dot" />重试保存</button>
          ) : saveState === "conflict" ? (
            <button className="save-status save-status--conflict save-status--action" type="button" onClick={onReloadNote}><span className="save-dot" />重新载入</button>
          ) : saveState === "idle" ? null : (
            <span className={`save-status save-status--${saveState}`} aria-live="polite"><span className="save-dot" />{saveLabel}</span>
          )}
          {onToggleFocusMode && (
            <button
              className={`icon-button ${focusMode ? "is-active" : ""}`}
              type="button"
              aria-label={focusMode ? "退出沉浸模式" : "沉浸编辑模式"}
              title={focusMode ? "退出沉浸模式 (Esc 或 ⌘/Ctrl+Shift+F)" : "沉浸编辑模式 (⌘/Ctrl+Shift+F)"}
              onClick={onToggleFocusMode}
              disabled={editorLocked}
            >
              {focusMode ? <Minimize2 size={18} strokeWidth={1.8} /> : <Maximize2 size={18} strokeWidth={1.8} />}
            </button>
          )}
          <button className={`icon-button ${note.isFavorite ? "is-active" : ""}`} type="button" aria-label={note.isFavorite ? "取消收藏" : "收藏笔记"} title={note.isFavorite ? "取消收藏" : "收藏笔记"} onClick={onToggleFavorite} disabled={editorLocked}><span className="star-glyph">★</span></button>
          <button className="icon-button" type="button" aria-label="分享笔记" title="分享笔记" onClick={onShare} disabled={editorLocked}><Link2 size={18} strokeWidth={1.8} /></button>
          {note.deletedAt ? <>
            <button className="icon-button" type="button" aria-label="恢复笔记" title="恢复笔记" onClick={onRestore} disabled={editorLocked || trashBusy}><Undo2 size={18} strokeWidth={1.8} /></button>
            {onPermanentDelete && <button className="icon-button danger-button" type="button" aria-label="彻底删除" title="彻底删除" onClick={onPermanentDelete} disabled={editorLocked || trashBusy}><Trash2 size={18} strokeWidth={1.8} /></button>}
          </> : <button className="icon-button" type="button" aria-label="移入回收站" title="移入回收站" onClick={onMoveToTrash} disabled={editorLocked || trashBusy}><Minus size={18} strokeWidth={1.8} className="trash-mark" /></button>}
        </div>
      </header>
      {focusMode && onToggleFocusMode && (
        <button
          className="focus-mode-floating-exit"
          type="button"
          aria-label="退出沉浸模式"
          title="退出沉浸模式 (Esc)"
          onClick={onToggleFocusMode}
        >
          <Minimize2 size={14} strokeWidth={2} />
          <span>退出沉浸</span>
        </button>
      )}
      <div className="editor-scroll-shell">
        <div id="editor-scroll-region" className="editor-scroll floating-scrollbar-target" ref={editorScrollRef}>
          <div className="editor-document" ref={documentRef} onAnimationEnd={() => documentRef.current?.classList.remove("editor-document--entering")}>
            {note.deletedAt && (
              <div className="trashed-banner" role="status">
                <span>此笔记已在回收站中，恢复后可继续编辑。</span>
                <button className="text-button" type="button" onClick={onRestore} disabled={editorLocked || trashBusy}>立即恢复</button>
              </div>
            )}
            <input
              ref={titleInputRef}
              className="note-title-input"
              value={note.title}
              maxLength={200}
              readOnly={Boolean(note.deletedAt) || editorLocked}
              onChange={(event) => onChange({ title: event.target.value })}
              onBlur={() => { const trimmed = note.title.trim(); if (trimmed !== note.title) onChange({ title: trimmed }); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault();
                  editor?.commands.focus("start");
                }
              }}
              aria-label="笔记标题"
              placeholder="未命名笔记"
            />
            <EditorContent editor={editor} />
          </div>
        </div>
        <FloatingScrollbar scrollTargetRef={editorScrollRef} controlsId="editor-scroll-region" ariaLabel="编辑器滚动条" placement="right" />
      </div>
      {deferredLoading && <div className="editor-switch-overlay editor-switch-overlay--visible" role="status" aria-live="polite"><div className="editor-switch-card"><BrandMark className="editor-switch-mark" /><div className="editor-switch-lines" aria-hidden="true"><span /><span /><span /></div><strong>正在打开笔记…</strong></div></div>}
      <EditorFloatingTools
        floatingToolsRef={floatingToolsRef}
        outlineTriggerRef={outlineTriggerRef}
        outlineOpen={outlineOpen}
        outlineItems={outlineItems}
        activeOutlineId={activeOutlineId}
        editorStats={editorStats}
        onToggleOutline={() => setOutlineOpen((open) => !open)}
        onScrollToOutlineItem={scrollToOutlineItem}
        searchNavigation={searchNavigation}
        deferredLoading={editorLocked}
        onMoveSearchMatch={moveSearchMatch}
        onClearSearch={onClearSearch}
      />
    </section>
  );
}


function relativeDate(timestamp: number) {
  const diff = Math.max(0, Date.now() - timestamp * 1000);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(timestamp * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
