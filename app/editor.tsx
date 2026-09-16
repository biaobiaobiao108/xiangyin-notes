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
import { ChevronLeft, ImagePlus, Link2, Maximize2, Minimize2, Trash2, Undo2 } from "lucide-react";
import type { ImageAssetSummary, Note } from "../shared/types";
import { BrandMark } from "./brand-mark";
import { cycleSearchMatchIndex, findEditorSearchMatches, findTextMatches, searchHighlightPluginKey, SearchHighlightExtension } from "./editor-search";
import { buildOutlineItems, countEditorText, detectLeakedImePrefix, parseMarkdownBlockShortcut, shouldParseMarkdownPaste, type EditorStats, type MarkdownBlockShortcut, type OutlineItem } from "./editor-metrics";
import { FloatingScrollbar } from "./floating-scrollbar";
import { ImeMarkdownSafeExtension, imeMarkdownSafePluginKey } from "./ime-markdown-safe-extension";
import { editorCoreExtensionOptions } from "./editor/editor-config";
import { EditorFloatingTools } from "./editor/editor-panels";
import { ImageNode } from "./editor/image-node";
import { TagDecorationExtension } from "./editor/tag-decoration";

type EditorWithMarkdown = Editor & { getMarkdown: () => string };

const MAX_IMAGE_FILES_PER_ACTION = 10;

function isImageFile(file: File) {
  return /^image\/(?:jpeg|png|webp|gif)$/u.test(file.type) || /\.(?:jpe?g|png|webp|gif)$/iu.test(file.name);
}

async function imageDimensions(file: File) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dimensions;
    } catch {
      // Fall through to the HTMLImageElement path for browsers that cannot decode this file type with ImageBitmap.
    }
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function NoteEditor({ note, searchQuery = "", saveState, isLoading = false, reloadToken = 0, focusRequested = false, trashBusy = false, onFocusHandled, onChange, onSaveNow, onReloadNote, onShare, onToggleFavorite, onMoveToTrash, onRestore, onPermanentDelete, onOpenList, onUploadImage, focusMode = false, onToggleFocusMode, onClearSearch, typewriterMode = false }: {
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
  onUploadImage?: (file: File, dimensions: { width: number; height: number }) => Promise<{ asset: ImageAssetSummary; offline: boolean }>;
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
  onClearSearch?: () => void;
  typewriterMode?: boolean;
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
  const isPastingRef = useRef(false);
  const smoothScrollToHeadRef = useRef<(view: Editor["view"]) => void>(() => undefined);
  const outlineScrollAnimRef = useRef<number | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const imageUploadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadImageFilesRef = useRef<(files: File[]) => void>(() => undefined);
  const onUploadImageRef = useRef(onUploadImage);
  const imageUploadContextRef = useRef({ noteId: note.id, generation: 0 });
  if (imageUploadContextRef.current.noteId !== note.id) {
    imageUploadContextRef.current = { noteId: note.id, generation: imageUploadContextRef.current.generation + 1 };
  }
  const programmaticOutlineScrollIdRef = useRef<string | null>(null);
  const cancelOutlineSmoothScroll = useCallback(() => {
    if (outlineScrollAnimRef.current !== null) {
      cancelAnimationFrame(outlineScrollAnimRef.current);
      outlineScrollAnimRef.current = null;
    }
    programmaticOutlineScrollIdRef.current = null;
  }, []);
  const onChangeRef = useRef(onChange);
  const surfaceSyncRef = useRef<(instance: Editor) => void>(() => undefined);
  const [editorStats, setEditorStats] = useState<EditorStats>(() => countEditorText(""));
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [deferredLoading, setDeferredLoading] = useState(false);
  const [imageUploadState, setImageUploadState] = useState<"idle" | "uploading" | "error">("idle");
  const editorLocked = isLoading || deferredLoading;
  const [searchNavigation, setSearchNavigation] = useState({ activeIndex: 0, matchCount: 0 });
  const searchQueryRef = useRef(searchQuery);
  const searchNavigationRef = useRef(searchNavigation);
  searchQueryRef.current = searchQuery;
  searchNavigationRef.current = searchNavigation;
  onChangeRef.current = onChange;
  onUploadImageRef.current = onUploadImage;
  const typewriterModeRef = useRef(typewriterMode);
  typewriterModeRef.current = typewriterMode;
  const typewriterAnimRef = useRef<number | null>(null);
  const typewriterTargetRef = useRef<number | null>(null);

  const uploadImageFiles = useCallback(async (files: File[]) => {
    const editorInstance = editorInstanceRef.current;
    const uploadImage = onUploadImageRef.current;
    const uploadContext = imageUploadContextRef.current;
    const isCurrentUpload = () => imageUploadContextRef.current === uploadContext && editorInstanceRef.current === editorInstance && !editorInstance?.isDestroyed;
    if (!editorInstance || !uploadImage || editorLocked || note.deletedAt) return;
    const imageFiles = files.filter(isImageFile).slice(0, MAX_IMAGE_FILES_PER_ACTION);
    if (!imageFiles.length) return;
    setImageUploadState("uploading");
    if (imageUploadTimerRef.current !== null) clearTimeout(imageUploadTimerRef.current);
    try {
      for (const file of imageFiles) {
        const dimensions = await imageDimensions(file);
        if (!isCurrentUpload()) return;
        const result = await uploadImage(file, dimensions);
        if (!isCurrentUpload()) return;
        const maxWidth = Math.max(1, editorInstance.view.dom.closest(".note-prose")?.getBoundingClientRect().width ?? 820);
        const width = Math.min(maxWidth, Math.max(1, dimensions.width));
        const height = Math.max(1, Math.round(width * dimensions.height / Math.max(1, dimensions.width)));
        editorInstance.chain().focus().insertContent({ type: "image", attrs: { assetId: result.asset.id, src: result.asset.url, alt: result.asset.originalName.replace(/\.[^.]+$/u, "") || "图片", width, height } }).run();
      }
      setImageUploadState("idle");
    } catch {
      if (!isCurrentUpload()) return;
      setImageUploadState("error");
      imageUploadTimerRef.current = setTimeout(() => { imageUploadTimerRef.current = null; setImageUploadState("idle"); }, 3000);
    }
  }, [editorLocked, note.deletedAt]);
  uploadImageFilesRef.current = (files) => { void uploadImageFiles(files); };

  useEffect(() => () => {
    if (imageUploadTimerRef.current !== null) clearTimeout(imageUploadTimerRef.current);
  }, []);

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
    ImageNode,
    ImeMarkdownSafeExtension,
    TagDecorationExtension,
    SearchHighlightExtension,
  ], []);

  const smoothScrollToHead = useCallback((view: Editor["view"]) => {
    requestAnimationFrame(() => {
      const scrollContainer = editorScrollRef.current;
      if (!scrollContainer) return;
      try {
        const head = view.state.selection.head;
        const coords = view.coordsAtPos(head);
        const containerRect = scrollContainer.getBoundingClientRect();
        const paddingBottom = 64;
        const isBelow = coords.bottom > containerRect.bottom - paddingBottom;
        const isAbove = coords.top < containerRect.top + 24;

        if (isBelow) {
          const diff = coords.bottom - (containerRect.bottom - paddingBottom);
          const maxScroll = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
          const targetScrollTop = Math.min(maxScroll, scrollContainer.scrollTop + diff);
          const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          if (prefersReducedMotion) {
            scrollContainer.scrollTop = targetScrollTop;
          } else {
            scrollContainer.scrollTo({
              top: targetScrollTop,
              behavior: "smooth",
            });
          }
        } else if (isAbove) {
          const diff = (containerRect.top + 24) - coords.top;
          const targetScrollTop = Math.max(0, scrollContainer.scrollTop - diff);
          const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          if (prefersReducedMotion) {
            scrollContainer.scrollTop = targetScrollTop;
          } else {
            scrollContainer.scrollTo({
              top: targetScrollTop,
              behavior: "smooth",
            });
          }
        }
      } catch {
        // coordsAtPos may throw if editor position is not yet rendered
      }
    });
  }, []);
  smoothScrollToHeadRef.current = smoothScrollToHead;

  const alignTypewriter = useCallback((target: Editor | Editor["view"], immediate = false) => {
    if (!typewriterModeRef.current) return;
    const view = "view" in target ? target.view : target;
    if (!view || view.isDestroyed || !view.hasFocus()) return;

    requestAnimationFrame(() => {
      const scrollContainer = editorScrollRef.current;
      if (!scrollContainer || !view || view.isDestroyed || !view.hasFocus()) return;

      try {
        const head = view.state.selection.head;
        const coords = view.coordsAtPos(head);
        const containerRect = scrollContainer.getBoundingClientRect();
        const cursorCenterY = (coords.top + coords.bottom) / 2;
        const targetY = containerRect.top + containerRect.height * 0.6;
        const delta = cursorCenterY - targetY;
        const maxScroll = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        const targetScrollTop = Math.min(maxScroll, Math.max(0, Math.round(scrollContainer.scrollTop + delta)));

        // Negligible distance: prevent jitter on same-line typing
        if (Math.abs(scrollContainer.scrollTop - targetScrollTop) < 2) {
          return;
        }

        // Already animating to this target position: do not restart
        if (typewriterTargetRef.current !== null && Math.abs(typewriterTargetRef.current - targetScrollTop) < 2) {
          return;
        }

        const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (prefersReducedMotion || immediate) {
          if (typewriterAnimRef.current !== null) {
            cancelAnimationFrame(typewriterAnimRef.current);
            typewriterAnimRef.current = null;
          }
          scrollContainer.scrollTop = targetScrollTop;
          typewriterTargetRef.current = null;
          return;
        }

        if (typewriterAnimRef.current !== null) {
          cancelAnimationFrame(typewriterAnimRef.current);
          typewriterAnimRef.current = null;
        }

        const startTop = scrollContainer.scrollTop;
        const distance = targetScrollTop - startTop;
        const duration = 160;
        const startTime = performance.now();
        const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);

        const step = (now: number) => {
          const elapsed = now - startTime;
          const progress = Math.min(1, elapsed / duration);
          const eased = easeOutQuart(progress);
          scrollContainer.scrollTop = Math.round(startTop + distance * eased);

          if (progress < 1) {
            typewriterAnimRef.current = requestAnimationFrame(step);
          } else {
            scrollContainer.scrollTop = targetScrollTop;
            typewriterAnimRef.current = null;
            typewriterTargetRef.current = null;
          }
        };

        typewriterTargetRef.current = targetScrollTop;
        typewriterAnimRef.current = requestAnimationFrame(step);
      } catch {
        // coordsAtPos may throw if selection position is not yet rendered
      }
    });
  }, []);
  const alignTypewriterRef = useRef(alignTypewriter);
  alignTypewriterRef.current = alignTypewriter;

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
      const imageFiles = Array.from(event.clipboardData?.files ?? []).filter(isImageFile);
      if (imageFiles.length) {
        event.preventDefault();
        uploadImageFilesRef.current(imageFiles);
        return true;
      }
      isPastingRef.current = true;
      window.setTimeout(() => {
        isPastingRef.current = false;
      }, 200);
      const text = event.clipboardData?.getData("text/plain") ?? "";
      const html = event.clipboardData?.getData("text/html") ?? "";
      if (!shouldParseMarkdownPaste(text, Boolean(html))) return false;
      const markdownManager = editorInstanceRef.current?.markdown;
      if (!markdownManager) return false;
      try {
        const parsedDocument = view.state.schema.nodeFromJSON(markdownManager.parse(text));
        const slice = parsedDocument.slice(0, parsedDocument.content.size);
        view.dispatch(view.state.tr.replaceSelection(slice).setMeta("uiEvent", "paste"));
        isPastingRef.current = false;
        smoothScrollToHeadRef.current(view);
        return true;
      } catch {
        return false;
      }
    },
    handleDrop: (_view: Editor["view"], event: DragEvent, _slice: unknown, moved: boolean) => {
      if (moved) return false;
      const imageFiles = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile);
      if (!imageFiles.length) return false;
      event.preventDefault();
      uploadImageFilesRef.current(imageFiles);
      return true;
    },
    handleScrollToSelection: (view: Editor["view"]) => {
      if (isPastingRef.current) {
        isPastingRef.current = false;
        smoothScrollToHeadRef.current(view);
        return true;
      }
      if (typewriterModeRef.current) {
        alignTypewriterRef.current(view);
        return true;
      }
      return false;
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
          if (typewriterModeRef.current) {
            alignTypewriterRef.current(editorInstanceRef.current);
          }
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
      if (typewriterModeRef.current && !instance.view.composing && !composingRef.current) {
        alignTypewriterRef.current(instance);
      }
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
    const handleSelection = ({ editor: instance }: { editor: Editor }) => {
      if (typewriterModeRef.current) {
        alignTypewriterRef.current(instance);
      }
    };
    editor.on("transaction", handleTransaction);
    editor.on("selectionUpdate", handleSelection);
    syncSearchNavigation(editor);
    return () => {
      editor.off("transaction", handleTransaction);
      editor.off("selectionUpdate", handleSelection);
    };
  }, [editor, syncSearchNavigation]);

  useEffect(() => {
    if (typewriterMode && editorInstanceRef.current?.view.hasFocus()) {
      alignTypewriterRef.current(editorInstanceRef.current);
    } else if (!typewriterMode) {
      if (typewriterAnimRef.current !== null) {
        cancelAnimationFrame(typewriterAnimRef.current);
        typewriterAnimRef.current = null;
        typewriterTargetRef.current = null;
      }
    }
  }, [typewriterMode]);

  useEffect(() => {
    const scrollContainer = editorScrollRef.current;
    if (!scrollContainer) return;
    const onManualScroll = () => {
      if (typewriterAnimRef.current !== null) {
        cancelAnimationFrame(typewriterAnimRef.current);
        typewriterAnimRef.current = null;
        typewriterTargetRef.current = null;
      }
    };
    scrollContainer.addEventListener("wheel", onManualScroll, { passive: true });
    scrollContainer.addEventListener("touchmove", onManualScroll, { passive: true });
    return () => {
      scrollContainer.removeEventListener("wheel", onManualScroll);
      scrollContainer.removeEventListener("touchmove", onManualScroll);
    };
  }, []);

  useEffect(() => {
    if (typewriterAnimRef.current !== null) {
      cancelAnimationFrame(typewriterAnimRef.current);
      typewriterAnimRef.current = null;
      typewriterTargetRef.current = null;
    }
  }, [note.id]);

  useEffect(() => () => {
    if (typewriterAnimRef.current !== null) {
      cancelAnimationFrame(typewriterAnimRef.current);
      typewriterAnimRef.current = null;
      typewriterTargetRef.current = null;
    }
  }, []);

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
    cancelOutlineSmoothScroll();
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
      if (programmaticOutlineScrollIdRef.current) return;
      const currentHeadings = getCurrentHeadings();
      const rootTop = root.getBoundingClientRect().top;
      const activationLine = rootTop + 32;
      let currentId: string | null = null;
      const maxScrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
      for (const [index, item] of outlineItems.entries()) {
        const element = currentHeadings[index];
        if (element && element.getBoundingClientRect().top <= activationLine) currentId = item.id;
        else if (currentId) break;
      }
      if (!currentId && root.scrollTop >= maxScrollTop - 1) {
        currentId = outlineItems[outlineItems.length - 1]?.id ?? null;
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

    const handleUserScroll = () => {
      cancelOutlineSmoothScroll();
      scheduleActiveHeading();
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
    root.addEventListener("wheel", handleUserScroll, { passive: true });
    root.addEventListener("touchstart", handleUserScroll, { passive: true });
    root.addEventListener("pointerdown", handleUserScroll, { passive: true });
    scheduleActiveHeading();
    return () => {
      observer?.disconnect();
      root.removeEventListener("scroll", scheduleActiveHeading);
      root.removeEventListener("wheel", handleUserScroll);
      root.removeEventListener("touchstart", handleUserScroll);
      root.removeEventListener("pointerdown", handleUserScroll);
      if (activeFrame !== null) cancelAnimationFrame(activeFrame);
      cancelOutlineSmoothScroll();
    };
  }, [cancelOutlineSmoothScroll, outlineItems]);

  const scrollToOutlineItem = useCallback((id: string) => {
    const scrollRoot = editorScrollRef.current;
    if (!scrollRoot) return;

    const itemIndex = outlineItems.findIndex((item) => item.id === id);
    const currentHeadings = Array.from(scrollRoot.querySelectorAll<HTMLElement>("h1, h2, h3")).filter((heading) => heading.textContent?.trim());
    const element = itemIndex >= 0 ? currentHeadings[itemIndex] : undefined;
    if (!element) return;

    cancelOutlineSmoothScroll();

    const rootRect = scrollRoot.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const maxScrollTop = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    const targetTop = Math.min(maxScrollTop, Math.max(0, scrollRoot.scrollTop + elementRect.top - rootRect.top - 24));

    setActiveOutlineId(id);
    programmaticOutlineScrollIdRef.current = id;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const startTop = scrollRoot.scrollTop;
    const distance = targetTop - startTop;

    if (prefersReducedMotion || Math.abs(distance) < 2) {
      scrollRoot.scrollTop = targetTop;
      programmaticOutlineScrollIdRef.current = null;
      return;
    }

    // 参照搜索导航的平滑过渡动画，并针对大纲跳转场景进行速度加快与敏捷调校（160ms ~ 240ms），
    // 配合 quartic ease-out 缓动曲线，比浏览器原生固定约 400~600ms 的平滑滚动更加轻快且视觉连贯。
    const duration = Math.min(240, Math.max(160, Math.round(Math.abs(distance) * 0.08 + 140)));
    const startTime = performance.now();
    const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      const eased = easeOutQuart(progress);
      scrollRoot.scrollTop = Math.round(startTop + distance * eased);

      if (progress < 1) {
        outlineScrollAnimRef.current = requestAnimationFrame(step);
      } else {
        scrollRoot.scrollTop = targetTop;
        outlineScrollAnimRef.current = null;
        programmaticOutlineScrollIdRef.current = null;
      }
    };

    outlineScrollAnimRef.current = requestAnimationFrame(step);
  }, [cancelOutlineSmoothScroll, outlineItems]);

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
          {onUploadImage && !note.deletedAt && <>
            <input ref={imageFileInputRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple tabIndex={-1} aria-label="选择要上传的图片文件" onChange={(event) => { uploadImageFilesRef.current(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            <button className={`icon-button ${imageUploadState === "uploading" ? "is-active" : ""}`} type="button" aria-label="上传图片" title={imageUploadState === "uploading" ? "正在上传图片" : "上传图片"} onClick={() => imageFileInputRef.current?.click()} disabled={editorLocked || imageUploadState === "uploading"}><ImagePlus size={18} strokeWidth={1.8} /></button>
          </>}
          {imageUploadState === "uploading" && <span className="save-status save-status--saving" role="status" aria-live="polite"><span className="save-dot" />上传中</span>}
          {imageUploadState === "error" && <span className="save-status save-status--error" role="alert">图片上传失败</span>}
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
          </> : <button className="icon-button" type="button" aria-label="移入回收站" title="移入回收站" onClick={onMoveToTrash} disabled={editorLocked || trashBusy}><Trash2 size={18} strokeWidth={1.8} /></button>}
        </div>
      </header>
      <div className="editor-scroll-shell">
        <div id="editor-scroll-region" className={`editor-scroll floating-scrollbar-target ${typewriterMode ? "is-typewriter-mode" : ""}`} ref={editorScrollRef}>
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
