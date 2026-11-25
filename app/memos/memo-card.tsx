import { FileText, Trash2 } from "lucide-react";
import {
  type CSSProperties,
  type ContextType,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Memo } from "../../shared/types";
import { copyPlainText } from "../editor/code-block-copy";
import { MemoDiagramPreviews } from "../mermaid/diagram-preview";
import { useSwipeActionGesture } from "../workspace/swipe-actions";
import { MemoComposer, type MemoComposerHandle } from "./memo-composer";
import { dayHeading, localDateKey, timeLabel } from "./memo-date";
import { beginMemoDraftSession } from "./memo-edit-draft";
import { MemoMarkdown } from "./memo-markdown";
import { memoConflictCurrent, useMemoWorkspace } from "./memo-workspace";

export type MemoNotice = { message: string; error?: boolean };

export function memoSaveFailure(reason: unknown): MemoNotice {
  const detail =
    reason instanceof TypeError
      ? "请检查网络后重试。"
      : reason instanceof Error && reason.message
        ? reason.message
        : "请重试。";
  return { message: `随记未保存，草稿仍可编辑。${detail}`, error: true };
}

function MemoCardEditor({
  memo,
  editingVersion,
  diagramPreviews,
  foregroundRef,
  onFinishEdit,
  onSaveNotice,
}: {
  memo: Memo;
  editingVersion: number | null;
  diagramPreviews: NonNullable<ContextType<typeof MemoDiagramPreviews>>;
  foregroundRef: RefObject<HTMLElement | null>;
  onFinishEdit: () => void;
  onSaveNotice: (notice: MemoNotice) => void;
}) {
  const { updateMemo, refresh } = useMemoWorkspace();
  const [draftSession] = useState(() => beginMemoDraftSession(memo.id));
  const [conflict, setConflict] = useState<Memo | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const composerRef = useRef<MemoComposerHandle>(null);
  const editDraft = draftSession.initial;
  const editVersion = editDraft?.version ?? editingVersion ?? memo.version;
  const conflictMemo = conflict ?? (editDraft?.conflict ? memo : null);
  const writeEditDraft = (markdown: string) => {
    draftSession.write(
      markdown || conflictMemo
        ? {
            markdown,
            version: conflictMemo?.version ?? editVersion,
            ...(conflictMemo ? { conflict: true } : {}),
          }
        : null,
    );
  };

  const discardRecoveredDraft = () => {
    composerRef.current?.discardPendingDraft();
    draftSession.clear({ includeInitial: true });
    setConflict(null);
    setCopyNotice("");
    refresh();
    onFinishEdit();
  };

  return (
    <>
      <MemoDiagramPreviews.Provider value={diagramPreviews}>
        <MemoComposer
          ref={composerRef}
          key={memo.id}
          initialMarkdown={editDraft?.markdown ?? memo.contentMarkdown}
          placeholder="修改这条随记"
          ariaLabel="编辑随记"
          autoFocus
          onSaveError={(reason) => {
            if (!memoConflictCurrent(reason)) onSaveNotice(memoSaveFailure(reason));
          }}
          onSubmit={async (markdown, unchangedSource) => {
            if (conflictMemo) throw new Error("请先处理冲突草稿，再保存随记。");
            if (unchangedSource === memo.contentMarkdown) {
              draftSession.clear({
                includeInitial: unchangedSource === editDraft?.markdown,
              });
              onFinishEdit();
              return;
            }
            try {
              await updateMemo({ ...memo, version: editVersion }, markdown);
            } catch (reason) {
              const current = memoConflictCurrent(reason);
              if (current) {
                draftSession.write({
                  markdown,
                  version: current.version,
                  conflict: true,
                });
                setConflict(current);
              }
              throw reason;
            }
            draftSession.clear({ includeInitial: true });
            onFinishEdit();
            onSaveNotice({ message: "随记已保存" });
          }}
          onDraftChange={writeEditDraft}
          onCancel={() => {
            if (!conflictMemo) draftSession.clear();
            onFinishEdit();
            requestAnimationFrame(() => foregroundRef.current?.focus({ preventScroll: true }));
          }}
        />
      </MemoDiagramPreviews.Provider>
      {conflictMemo && (
        <section className="memo-conflict" aria-label="随记保存冲突">
          <p>这条随记已在别处更新。草稿已保留，请选择如何处理。</p>
          <div className="memo-conflict-actions">
            <button
              type="button"
              onClick={() => {
                void copyPlainText(composerRef.current?.getMarkdown() ?? "")
                  .then(() => setCopyNotice("草稿已复制"))
                  .catch(() => setCopyNotice("复制失败，请重试"))
                  .finally(() => window.setTimeout(() => setCopyNotice(""), 1600));
              }}
            >
              复制草稿
            </button>
            <button type="button" onClick={discardRecoveredDraft}>
              丢弃草稿并编辑最新内容
            </button>
          </div>
          {copyNotice && (
            <p className="memo-conflict-notice" role="status">
              {copyNotice}
            </p>
          )}
          <details>
            <summary>查看最新随记</summary>
            <MemoMarkdown markdown={conflictMemo.contentMarkdown} />
          </details>
        </section>
      )}
      {editDraft && !conflictMemo && (
        <div className="memo-conflict memo-conflict-actions">
          <button type="button" onClick={discardRecoveredDraft}>
            丢弃已恢复草稿
          </button>
        </div>
      )}
    </>
  );
}

export function MemoCard({
  memo,
  onEdit,
  editing,
  editingVersion,
  onFinishEdit,
  onSaveNotice,
  onDelete,
  onConvert,
  mobile,
  swipeOpen,
  setSwipeOpenId,
}: {
  memo: Memo;
  onEdit: () => void;
  editing: boolean;
  editingVersion: number | null;
  onFinishEdit: () => void;
  onSaveNotice: (notice: MemoNotice) => void;
  onDelete: (memo: Memo) => Promise<void>;
  onConvert: (memo: Memo) => Promise<void>;
  mobile: boolean;
  swipeOpen: boolean;
  setSwipeOpenId: (id: string | null) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const diagramPreviews = useRef<NonNullable<ContextType<typeof MemoDiagramPreviews>>>(new Map());
  const foregroundRef = useRef<HTMLElement>(null);
  const gesture = useSwipeActionGesture({
    enabled: mobile && !editing && !deleting,
    itemId: memo.id,
    open: swipeOpen,
    actionWidth: 144,
    onOpenChange: setSwipeOpenId,
    foregroundRef,
  });

  useLayoutEffect(() => {
    const card = foregroundRef.current;
    if (!card?.style.minBlockSize) return;
    const frame = requestAnimationFrame(() => {
      card.style.minBlockSize = "";
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  const beginEdit = (target?: EventTarget | null) => {
    if (
      target instanceof Element &&
      target.closest(
        "a,button,input,textarea,select,summary,[contenteditable='true'],[role='button'],[role='scrollbar']",
      )
    )
      return;
    onEdit();
  };

  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await onDelete(memo);
    } catch (reason) {
      setDeleteError(reason instanceof Error && reason.message ? reason.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className={`swipe-action-row memo-card-swipe${swipeOpen ? " is-swipe-open" : ""}`}
      style={
        { "--swipe-action-width": "144px", "--swipe-action-button-width": "72px" } as CSSProperties
      }
      {...gesture}
    >
      {mobile && !editing && (
        <div
          className="swipe-action-buttons"
          role="group"
          aria-label="随记操作"
          aria-hidden={!swipeOpen}
          inert={!swipeOpen}
        >
          <button
            type="button"
            className="swipe-action-button"
            tabIndex={swipeOpen ? 0 : -1}
            aria-label="转为笔记"
            disabled={deleting}
            onClick={() => {
              setSwipeOpenId(null);
              setDeleteError("");
              void onConvert(memo).catch((reason) =>
                setDeleteError(reason instanceof Error ? reason.message : "转换失败"),
              );
            }}
          >
            <span className="swipe-action-icon">
              <FileText size={17} aria-hidden="true" />
            </span>
          </button>
          <button
            type="button"
            className="swipe-action-button is-danger"
            tabIndex={swipeOpen ? 0 : -1}
            aria-label="删除随记"
            disabled={deleting}
            onClick={() => {
              setSwipeOpenId(null);
              void remove();
            }}
          >
            <span className="swipe-action-icon">
              <Trash2 size={17} aria-hidden="true" />
            </span>
          </button>
        </div>
      )}
      <article
        ref={foregroundRef}
        className={`memo-card swipe-action-foreground ${editing ? "is-editing" : ""}`.trim()}
        data-memo-id={memo.id}
        tabIndex={editing ? -1 : 0}
        aria-label={`${dayHeading(localDateKey(memo.createdAt))} ${timeLabel(memo.createdAt)} 的随记，按 Enter 编辑`}
        onDoubleClick={(event) => beginEdit(event.target)}
        onKeyDown={(event) => {
          if (editing || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" || event.key === "F2") {
            if (
              event.target instanceof Element &&
              event.target.closest(
                "a,button,input,textarea,select,summary,[contenteditable='true']",
              )
            )
              return;
            event.preventDefault();
            onEdit();
          }
        }}
      >
        {!mobile && (
          <button
            className="memo-card-convert"
            type="button"
            aria-label="转为笔记"
            disabled={deleting || editing}
            onClick={() => {
              setDeleteError("");
              void onConvert(memo).catch((reason) =>
                setDeleteError(reason instanceof Error ? reason.message : "转换失败"),
              );
            }}
          >
            <FileText size={16} aria-hidden="true" />
          </button>
        )}
        <header className="memo-card-header">
          <time dateTime={new Date(memo.createdAt).toISOString()}>{timeLabel(memo.createdAt)}</time>
        </header>
        {editing ? (
          <MemoCardEditor
            key={memo.id}
            memo={memo}
            editingVersion={editingVersion}
            diagramPreviews={diagramPreviews.current}
            foregroundRef={foregroundRef}
            onFinishEdit={onFinishEdit}
            onSaveNotice={onSaveNotice}
          />
        ) : (
          <div className="memo-card-content">
            <MemoDiagramPreviews.Provider value={diagramPreviews.current}>
              <MemoMarkdown markdown={memo.contentMarkdown} />
            </MemoDiagramPreviews.Provider>
          </div>
        )}
        {deleteError && (
          <p className="memo-card-error" role="alert">
            {deleteError}
          </p>
        )}
      </article>
    </div>
  );
}
