import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import { ChevronLeft, Link2, ListTree, Minus, Trash2, Undo2 } from "lucide-react";
import type { Note } from "../shared/types";
import { BrandMark } from "./brand-mark";
import { buildOutlineItems, countEditorText, isMarkdownHeadingMarker, parseMarkdownHeadingPrefix, shouldParseMarkdownPaste, type EditorStats, type OutlineItem } from "./editor-metrics";
import { FloatingScrollbar } from "./floating-scrollbar";

type EditorWithMarkdown = Editor & { getMarkdown: () => string };

export function NoteEditor({ note, saveState, isLoading = false, reloadToken = 0, onChange, onSaveNow, onReloadNote, onShare, onToggleFavorite, onMoveToTrash, onRestore, onPermanentDelete, onOpenList }: {
  note: Note;
  saveState: "idle" | "saving" | "saved" | "conflict" | "error";
  isLoading?: boolean;
  reloadToken?: number;
  onChange: (patch: { title?: string; contentMarkdown?: string; notebookId?: string }) => void;
  onSaveNow: () => void;
  onReloadNote: () => void;
  onShare: () => void;
  onToggleFavorite: () => void;
  onMoveToTrash: () => void;
  onRestore: () => void;
  onPermanentDelete?: () => void;
  onOpenList?: () => void;
}) {
  const editorScrollRef = useRef<HTMLDivElement>(null);
  const editorInstanceRef = useRef<Editor | null>(null);
  const floatingToolsRef = useRef<HTMLDivElement>(null);
  const outlineTriggerRef = useRef<HTMLButtonElement>(null);
  const headingElementsRef = useRef(new Map<string, HTMLElement>());
  const syncFrameRef = useRef<number | null>(null);
  const composingRef = useRef(false);
  const pendingHeadingRef = useRef(false);
  const headingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeEditorNoteIdRef = useRef(note.id);
  const [editorStats, setEditorStats] = useState<EditorStats>(() => countEditorText(""));
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);

  const emitMarkdown = (instance: Editor) => onChange({ contentMarkdown: (instance as EditorWithMarkdown).getMarkdown() });
  const syncEditorSurface = (instance: Editor) => {
    const editorText = instance.getText({ blockSeparator: "\n" });
    const nextStats = countEditorText(editorText);
    setEditorStats((current) => current.wordCount === nextStats.wordCount && current.characterCount === nextStats.characterCount ? current : nextStats);

    const headings = Array.from(instance.view.dom.querySelectorAll<HTMLElement>("h1, h2, h3"))
      .map((element) => ({ level: Number(element.tagName.slice(1)) as 1 | 2 | 3, title: element.textContent?.trim() ?? "", element }))
      .filter((heading) => heading.title.length > 0);
    const nextItems = buildOutlineItems(headings.map(({ level, title }) => ({ level, title })));
    const nextElements = new Map<string, HTMLElement>();
    headings.forEach((heading, index) => {
      const item = nextItems[index];
      if (!item) return;
      heading.element.id = item.id;
      nextElements.set(item.id, heading.element);
    });
    headingElementsRef.current = nextElements;
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

  const clearHeadingTimer = () => {
    if (headingTimerRef.current !== null) clearTimeout(headingTimerRef.current);
    headingTimerRef.current = null;
  };
  const convertPendingHeading = (view: Editor["view"]) => {
    const { $from } = view.state.selection;
    if ($from.parent.type.name !== "paragraph") return;
    const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\uFFFC");
    const prefix = parseMarkdownHeadingPrefix(textBefore);
    const heading = view.state.schema.nodes.heading;
    if (!prefix || !heading) return;
    const start = $from.start();
    const end = start + prefix.length;
    view.dispatch(view.state.tr.delete(start, end).setBlockType(start, start, heading, { level: prefix.level }));
  };
  const scheduleHeadingConversion = (view: Editor["view"], delay = 450) => {
    clearHeadingTimer();
    headingTimerRef.current = setTimeout(() => {
      headingTimerRef.current = null;
      if (composingRef.current || view.composing) return;
      pendingHeadingRef.current = false;
      convertPendingHeading(view);
    }, delay);
  };

  const editor = useEditor({
    editable: !note.deletedAt && !isLoading,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false }),
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: "从一句话开始……" }),
      Markdown,
    ],
    content: note.contentMarkdown,
    contentType: "markdown",
    editorProps: {
      attributes: { class: "note-prose" },
      handleClick: (_view, _pos, event) => {
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
      handlePaste: (view, event) => {
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
      handleKeyDown: (_view, event) => {
        if (!pendingHeadingRef.current) return false;
        // Chromium reports the first key from many Windows IMEs as 229
        // before compositionstart reaches the editor.
        if (event.isComposing || event.keyCode === 229) {
          composingRef.current = true;
          clearHeadingTimer();
        }
        return false;
      },
      handleTextInput: (view, from, to, text) => {
        if (text !== " " || from !== to || composingRef.current || view.composing) return false;
        const $from = view.state.doc.resolve(from);
        if ($from.parent.type.name !== "paragraph") return false;
        const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\uFFFC");
        if (!isMarkdownHeadingMarker(textBefore)) return false;
        view.dispatch(view.state.tr.insertText(text, from, to));
        pendingHeadingRef.current = true;
        scheduleHeadingConversion(view);
        return true;
      },
      handleDOMEvents: {
        compositionstart: () => {
          composingRef.current = true;
          clearHeadingTimer();
          return false;
        },
        compositionend: (view) => {
          composingRef.current = false;
          if (pendingHeadingRef.current) scheduleHeadingConversion(view, 0);
          return false;
        },
        compositioncancel: (view) => {
          composingRef.current = false;
          if (pendingHeadingRef.current) scheduleHeadingConversion(view, 0);
          return false;
        },
      },
    },
    onUpdate: ({ editor: instance }) => {
      emitMarkdown(instance);
      scheduleEditorSurfaceSync(instance);
    },
  });

  useEffect(() => {
    editorInstanceRef.current = editor;
    return () => {
      if (editorInstanceRef.current === editor) editorInstanceRef.current = null;
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    scheduleEditorSurfaceSync(editor);
    return () => {
      if (syncFrameRef.current !== null) cancelAnimationFrame(syncFrameRef.current);
      syncFrameRef.current = null;
      clearHeadingTimer();
      pendingHeadingRef.current = false;
      composingRef.current = false;
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!note.deletedAt && !isLoading, false);
  }, [editor, isLoading, note.deletedAt]);

  const appliedReloadTokenRef = useRef(reloadToken);
  useEffect(() => {
    if (!editor) return;
    const switchedNote = activeEditorNoteIdRef.current !== note.id;
    if (!switchedNote && appliedReloadTokenRef.current === reloadToken) return;
    appliedReloadTokenRef.current = reloadToken;
    activeEditorNoteIdRef.current = note.id;
    clearHeadingTimer();
    pendingHeadingRef.current = false;
    composingRef.current = false;
    setOutlineOpen(false);
    setActiveOutlineId(null);
    setOutlineItems([]);
    setEditorStats(countEditorText(""));
    editor.commands.setContent(note.contentMarkdown, { contentType: "markdown", emitUpdate: false });
    editorScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    scheduleEditorSurfaceSync(editor);
  }, [editor, note.id, reloadToken]);

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
    const updateActiveHeading = () => {
      const rootTop = root.getBoundingClientRect().top;
      const activationLine = rootTop + Math.min(root.clientHeight * 0.24, 180);
      let currentId: string | null = null;
      for (const item of outlineItems) {
        const element = headingElementsRef.current.get(item.id);
        if (element && element.getBoundingClientRect().top <= activationLine) currentId = item.id;
        else if (currentId) break;
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
    for (const item of outlineItems) {
      const element = headingElementsRef.current.get(item.id);
      if (element) observer?.observe(element);
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
    const element = headingElementsRef.current.get(id);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveOutlineId(id);
  };

  const saveLabel = saveState === "saving" ? "保存中" : "已保存";
  return (
    <section className={`editor-panel ${isLoading ? "is-loading" : ""}`} aria-label="笔记编辑器" aria-busy={isLoading} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "s") { event.preventDefault(); onSaveNow(); } }}>
      <header className="editor-header">
        <div className="editor-header-start">
          {onOpenList && <button className="icon-button mobile-only editor-back" type="button" aria-label="返回笔记列表" onClick={onOpenList} disabled={isLoading}><ChevronLeft size={20} /></button>}
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
          <button className={`icon-button ${note.isFavorite ? "is-active" : ""}`} type="button" aria-label={note.isFavorite ? "取消收藏" : "收藏笔记"} title={note.isFavorite ? "取消收藏" : "收藏笔记"} onClick={onToggleFavorite} disabled={isLoading}><span className="star-glyph">★</span></button>
          <button className="icon-button" type="button" aria-label="分享笔记" title="分享笔记" onClick={onShare} disabled={isLoading}><Link2 size={18} strokeWidth={1.8} /></button>
          {note.deletedAt ? <>
            <button className="icon-button" type="button" aria-label="恢复笔记" title="恢复笔记" onClick={onRestore} disabled={isLoading}><Undo2 size={18} strokeWidth={1.8} /></button>
            {onPermanentDelete && <button className="icon-button danger-button" type="button" aria-label="彻底删除" title="彻底删除" onClick={onPermanentDelete} disabled={isLoading}><Trash2 size={18} strokeWidth={1.8} /></button>}
          </> : <button className="icon-button" type="button" aria-label="移入回收站" title="移入回收站" onClick={onMoveToTrash} disabled={isLoading}><Minus size={18} strokeWidth={1.8} className="trash-mark" /></button>}
        </div>
      </header>
      <div className="editor-scroll-shell">
        <div id="editor-scroll-region" className="editor-scroll floating-scrollbar-target" ref={editorScrollRef}>
          <div className="editor-document">
            {note.deletedAt && (
              <div className="trashed-banner" role="status">
                <span>此笔记已在回收站中，恢复后可继续编辑。</span>
                <button className="text-button" type="button" onClick={onRestore} disabled={isLoading}>立即恢复</button>
              </div>
            )}
            <input
              className="note-title-input"
              value={note.title}
              maxLength={200}
              readOnly={Boolean(note.deletedAt) || isLoading}
              onChange={(event) => onChange({ title: event.target.value })}
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
      {isLoading && <div className="editor-switch-overlay" role="status" aria-live="polite"><div className="editor-switch-card"><BrandMark className="editor-switch-mark" /><div className="editor-switch-lines" aria-hidden="true"><span /><span /><span /></div><strong>正在打开笔记…</strong></div></div>}
      <div className="editor-floating-tools" ref={floatingToolsRef}>
        <aside className="editor-outline" id="note-outline" aria-label="笔记大纲" hidden={!outlineOpen}>
          <div className="editor-outline-heading">
            <div>
              <span className="editor-outline-eyebrow">NAVIGATION</span>
              <h2>笔记大纲</h2>
            </div>
            <span className="editor-outline-count">{outlineItems.length}</span>
          </div>
          {outlineItems.length > 0 ? <nav aria-label="笔记标题">
            <ol className="editor-outline-list">
              {outlineItems.map((item) => <li className={`editor-outline-item editor-outline-item--level-${item.level}`} key={item.id}>
                <button type="button" aria-current={activeOutlineId === item.id ? "true" : undefined} onClick={() => scrollToOutlineItem(item.id)}>{item.title}</button>
              </li>)}
            </ol>
          </nav> : <p className="editor-outline-empty">用 <code>#</code> 标题为这篇笔记建立大纲。</p>}
        </aside>
        <div className="editor-floating-row">
          <div className="editor-stats-pill" aria-label={`字数 ${editorStats.wordCount}，字符数 ${editorStats.characterCount}`}>
            <span className="editor-stat"><strong>{editorStats.wordCount}</strong><span>字数</span></span>
            <span className="editor-stat-divider" aria-hidden="true">·</span>
            <span className="editor-stat"><strong>{editorStats.characterCount}</strong><span>字符</span></span>
          </div>
          <button className={`outline-trigger ${outlineOpen ? "is-active" : ""}`} ref={outlineTriggerRef} type="button" aria-expanded={outlineOpen} aria-controls="note-outline" aria-label={outlineOpen ? "关闭笔记大纲" : "打开笔记大纲"} onClick={() => setOutlineOpen((open) => !open)} disabled={isLoading}>
            <ListTree size={16} strokeWidth={1.9} />
            <span>大纲</span>
          </button>
        </div>
      </div>
    </section>
  );
}

export function NoteLoadingState() {
  return <section className="editor-panel editor-loading-shell" aria-label="笔记编辑器" aria-busy="true"><div className="editor-switch-overlay editor-switch-overlay--visible" role="status" aria-live="polite"><div className="editor-switch-card"><BrandMark className="editor-switch-mark" /><div className="editor-switch-lines" aria-hidden="true"><span /><span /><span /></div><strong>正在打开笔记…</strong></div></div></section>;
}

export function ReadOnlyMarkdown({ markdown }: { markdown: string }) {
  const editor = useEditor({
    editable: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false }),
      Link.configure({ openOnClick: true, autolink: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown,
    ],
    content: markdown,
    contentType: "markdown",
    editorProps: { attributes: { class: "note-prose share-prose" } },
  });
  return <EditorContent editor={editor} />;
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
