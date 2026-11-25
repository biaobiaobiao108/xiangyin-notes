import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import { ChevronLeft, Trash2 } from "lucide-react";
import type { KanbanCard, KanbanPlacement, KanbanStatus, NoteSummary } from "../../shared/types";
import { playEntranceAnimation } from "../animation";
import { KanbanColumnView, type KanbanColumnData } from "./kanban-column";
import { AddExistingNoteModal, COLUMNS, MoveKanbanCardSheet } from "./kanban-dialogs";
import {
  KANBAN_DRAG_MIME_TYPE,
  parseKanbanDragPayload,
  type KanbanDragPayload,
} from "./kanban-drag";
import { NOTE_DRAG_MIME_TYPE, parseNoteIdsFromDrag, setNoteDragImage } from "./note-drag-drop";

export type { KanbanColumnData } from "./kanban-column";
export { getDialogTabTarget } from "./kanban-dialogs";

export type KanbanPanelProps = {
  columns: Record<KanbanStatus, KanbanColumnData>;
  loading?: boolean;
  onOpenNote: (noteId: string) => void;
  onCreateNoteInColumn: (status: KanbanStatus) => void;
  onAddExistingNote: (noteId: string, status: KanbanStatus) => void;
  onMoveCard: (noteId: string, targetStatus: KanbanStatus, placement: KanbanPlacement) => void;
  onTrashCard: (noteId: string) => void;
  onLoadMoreColumn: (status: KanbanStatus) => void;
  onToggleFavorite?: (note: NoteSummary) => void;
  onBack?: () => void;
  isMobileViewport?: boolean;
  availableNotes?: NoteSummary[];
};

export const KanbanPanel = memo(function KanbanPanel({
  columns,
  loading = false,
  onOpenNote,
  onCreateNoteInColumn,
  onAddExistingNote,
  onMoveCard,
  onTrashCard,
  onLoadMoreColumn,
  onToggleFavorite,
  onBack,
  isMobileViewport = false,
  availableNotes = [],
}: KanbanPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const [activeMobileColumn, setActiveMobileColumn] = useState<KanbanStatus>("inbox");
  const [draggingCard, setDraggingCard] = useState<KanbanDragPayload | null>(null);
  const draggingCardRef = useRef<KanbanDragPayload | null>(null);
  const [movingCard, setMovingCard] = useState<KanbanCard | null>(null);
  const [addModalStatus, setAddModalStatus] = useState<KanbanStatus | null>(null);
  const addNoteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [trashOver, setTrashOver] = useState(false);
  const moveCardRef = useRef<HTMLElement | null>(null);

  const allCards = useMemo(() => Object.values(columns).flatMap((col) => col.cards), [columns]);

  const totalNotesCount = useMemo(
    () => Object.values(columns).reduce((sum, col) => sum + (col.total ?? 0), 0),
    [columns],
  );

  const restoreMoveCardFocus = useCallback(() => {
    requestAnimationFrame(() => {
      if (moveCardRef.current?.isConnected) {
        moveCardRef.current.focus({ preventScroll: true });
        return;
      }
      panelRef.current
        ?.querySelector<HTMLButtonElement>(".kanban-mobile-tab.is-active")
        ?.focus({ preventScroll: true });
    });
  }, []);

  const handleRequestMoveCard = useCallback((card: KanbanCard, trigger: HTMLElement) => {
    moveCardRef.current = trigger;
    setMovingCard(card);
  }, []);

  const closeMoveCardSheet = useCallback(() => {
    setMovingCard(null);
    restoreMoveCardFocus();
  }, [restoreMoveCardFocus]);

  const handleMoveCardToStatus = useCallback(
    (targetStatus: KanbanStatus) => {
      if (!movingCard) return;
      if (targetStatus !== movingCard.status) {
        const targetCards = columns[targetStatus]?.cards ?? [];
        onMoveCard(movingCard.noteId, targetStatus, {
          beforeNoteId: targetCards[0]?.noteId ?? null,
        });
      }
      setMovingCard(null);
      restoreMoveCardFocus();
    },
    [columns, movingCard, onMoveCard, restoreMoveCardFocus],
  );

  // Entrance animation
  useLayoutEffect(() => {
    if (!panelRef.current) return;
    const columnElements = panelRef.current.querySelectorAll<HTMLElement>(
      ".kanban-column, .kanban-column-mobile-wrap",
    );
    const animations = [...columnElements]
      .map((col) => playEntranceAnimation(col, "page-content-in"))
      .filter((anim): anim is Animation => anim !== null);
    return () => animations.forEach((anim) => anim.cancel());
  }, []);

  const handleCardDragStart = useCallback(
    (card: KanbanCard, event: ReactDragEvent<HTMLElement>) => {
      if (isMobileViewport) return;
      const payload: KanbanDragPayload = {
        noteId: card.noteId,
      };
      event.dataTransfer.setData(KANBAN_DRAG_MIME_TYPE, JSON.stringify(payload));
      event.dataTransfer.setData(NOTE_DRAG_MIME_TYPE, JSON.stringify([card.noteId]));
      event.dataTransfer.setData("text/plain", card.noteId);
      event.dataTransfer.effectAllowed = "move";
      setNoteDragImage(event.dataTransfer, event.currentTarget, 1);

      // WebKit can dispatch drop before the next animation frame.
      draggingCardRef.current = payload;
      requestAnimationFrame(() => {
        if (draggingCardRef.current === payload) setDraggingCard(payload);
      });
    },
    [isMobileViewport],
  );

  const handleCardDragEnd = useCallback(() => {
    draggingCardRef.current = null;
    setDraggingCard(null);
    setTrashOver(false);
  }, []);

  const handleDropOnColumn = useCallback(
    (targetStatus: KanbanStatus, targetIndex: number) => {
      const dragged = draggingCardRef.current;
      if (!dragged) return;
      const target = columns[targetStatus];
      const nextCard = target.cards
        .slice(targetIndex)
        .find((card) => card.noteId !== dragged.noteId);
      // The last loaded card is not necessarily the last card in the column.
      const lastCard = target.cards.at(-1);
      const previousCard =
        target.hasMore && !nextCard
          ? lastCard?.noteId === dragged.noteId
            ? target.cards.at(-2)
            : lastCard
          : undefined;
      handleCardDragEnd();
      onMoveCard(
        dragged.noteId,
        targetStatus,
        previousCard
          ? { afterNoteId: previousCard.noteId }
          : { beforeNoteId: nextCard?.noteId ?? null },
      );
    },
    [columns, handleCardDragEnd, onMoveCard],
  );

  // Drop on Corner Trash Zone
  const handleTrashDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setTrashOver(true);
  };
  const handleTrashDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setTrashOver(false);
  };
  const handleTrashDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const payload = parseKanbanDragPayload(e.dataTransfer);
    const noteIds = parseNoteIdsFromDrag(e.dataTransfer);
    const targetId = payload?.noteId || noteIds[0] || draggingCardRef.current?.noteId;
    handleCardDragEnd();
    if (targetId) {
      onTrashCard(targetId);
    }
  };

  return (
    <section
      ref={panelRef}
      className={`kanban-panel ${isMobileViewport ? "is-mobile" : ""}`}
      aria-label="看板视图"
      aria-busy={loading}
    >
      {/* Mobile Top Header (Desktop has no top bar) */}
      {isMobileViewport && (
        <header className="list-header kanban-header">
          {onBack && (
            <button
              className="tasks-back tasks-header-back kanban-header-back"
              type="button"
              onClick={onBack}
              aria-label="返回"
            >
              <ChevronLeft size={18} aria-hidden="true" />
              <span>返回</span>
            </button>
          )}
          <div className="list-header-main">
            <h2>看板</h2>
            <p className="kanban-count">{totalNotesCount} 篇笔记</p>
          </div>
        </header>
      )}

      {/* Mobile Segmented Tabs */}
      {isMobileViewport && (
        <div className="kanban-mobile-tabs" role="tablist">
          {COLUMNS.map((col) => {
            const count = columns[col.id]?.total ?? 0;
            const active = activeMobileColumn === col.id;
            return (
              <button
                key={col.id}
                role="tab"
                aria-selected={active}
                className={`kanban-mobile-tab kanban-mobile-tab--${col.id} ${active ? "is-active" : ""}`}
                onClick={() => setActiveMobileColumn(col.id)}
              >
                <span
                  className={`kanban-column-dot kanban-column-dot--${col.id}`}
                  aria-hidden="true"
                />
                <span>{col.title}</span>
                <span className="kanban-mobile-tab-count">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Kanban Columns Board */}
      <div className="kanban-board">
        {isMobileViewport ? (
          <div className="kanban-column-mobile-wrap">
            {(() => {
              const activeCol = COLUMNS.find((c) => c.id === activeMobileColumn) ?? COLUMNS[0];
              return (
                <KanbanColumnView
                  key={activeCol.id}
                  column={activeCol}
                  columnData={columns[activeCol.id]}
                  isMobileViewport={true}
                  draggingNoteId={draggingCard?.noteId ?? null}
                  onOpenNote={onOpenNote}
                  onCreateNote={onCreateNoteInColumn}
                  onAddExistingNote={(status, trigger) => {
                    addNoteTriggerRef.current = trigger;
                    setAddModalStatus(status);
                  }}
                  onCardDragStart={handleCardDragStart}
                  onCardDragEnd={handleCardDragEnd}
                  onDropOnColumn={handleDropOnColumn}
                  onLoadMore={onLoadMoreColumn}
                  onToggleFavorite={onToggleFavorite}
                  onRequestMoveCard={handleRequestMoveCard}
                />
              );
            })()}
          </div>
        ) : (
          COLUMNS.map((col) => (
            <KanbanColumnView
              key={col.id}
              column={col}
              columnData={columns[col.id]}
              isMobileViewport={false}
              draggingNoteId={draggingCard?.noteId ?? null}
              onOpenNote={onOpenNote}
              onCreateNote={onCreateNoteInColumn}
              onAddExistingNote={(status, trigger) => {
                addNoteTriggerRef.current = trigger;
                setAddModalStatus(status);
              }}
              onCardDragStart={handleCardDragStart}
              onCardDragEnd={handleCardDragEnd}
              onDropOnColumn={handleDropOnColumn}
              onLoadMore={onLoadMoreColumn}
              onToggleFavorite={onToggleFavorite}
              onRequestMoveCard={handleRequestMoveCard}
            />
          ))
        )}
      </div>

      {/* Corner Drop Zone during drag (右下角移动到回收站) */}
      {draggingCard !== null && (
        <div
          className={`kanban-corner-zone kanban-corner-zone--trash ${trashOver ? "is-over" : ""}`}
          onDragOver={handleTrashDragOver}
          onDragLeave={handleTrashDragLeave}
          onDrop={handleTrashDrop}
          role="region"
          aria-label="拖拽至此移到回收站"
        >
          <div className="kanban-corner-zone-content">
            <div className="kanban-corner-icon-circle">
              <Trash2 size={18} className="kanban-corner-icon" />
            </div>
            <span className="kanban-corner-label">移到回收站</span>
          </div>
        </div>
      )}

      {isMobileViewport && movingCard && (
        <MoveKanbanCardSheet
          card={movingCard}
          onClose={closeMoveCardSheet}
          onSelect={handleMoveCardToStatus}
        />
      )}

      {/* Add Existing Note Dialog */}
      <AddExistingNoteModal
        open={addModalStatus !== null}
        targetStatus={addModalStatus ?? "inbox"}
        availableNotes={availableNotes}
        cards={allCards}
        returnFocus={addNoteTriggerRef.current}
        onClose={() => setAddModalStatus(null)}
        onSelect={onAddExistingNote}
      />
    </section>
  );
});
