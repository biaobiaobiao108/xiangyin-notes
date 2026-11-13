import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { useMemo, useRef, type KeyboardEvent } from "react";
import {
  addMonths,
  buildMonthCells,
  currentMonthKey,
  dayHeading,
  localDateKey,
  monthLabel,
  weekdayLabels,
} from "./memo-date";

type CalendarCounts = Record<string, number>;

function countLabel(date: string, count: number) {
  return `${dayHeading(date)}，${count} 条随记`;
}

function monthCells(month: string) {
  return buildMonthCells(month);
}

export function MiniCalendar({
  month,
  counts,
  selectedDate,
  loading,
  error,
  onMonthChange,
  onSelectDate,
}: {
  month: string;
  counts: CalendarCounts;
  selectedDate: string | null;
  loading: boolean;
  error?: string | null;
  onMonthChange: (month: string) => void;
  onSelectDate: (date: string | null) => void;
}) {
  const cells = useMemo(() => monthCells(month), [month]);
  const gridRef = useRef<HTMLDivElement>(null);
  const today = localDateKey(Date.now());
  const focusDate = cells.some((cell) => cell.date === selectedDate)
    ? selectedDate
    : cells.some((cell) => cell.date === today)
      ? today
      : cells.find((cell) => cell.inMonth)?.date;

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = (event.target as HTMLElement).dataset.date;
    if (!current) return;
    const date = new Date(`${current}T12:00:00`);
    let next: string | null = null;
    if (event.key === "ArrowLeft") (date.setDate(date.getDate() - 1), (next = localDateKey(date)));
    if (event.key === "ArrowRight") (date.setDate(date.getDate() + 1), (next = localDateKey(date)));
    if (event.key === "ArrowUp") (date.setDate(date.getDate() - 7), (next = localDateKey(date)));
    if (event.key === "ArrowDown") (date.setDate(date.getDate() + 7), (next = localDateKey(date)));
    if (!next) return;
    const target = gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`);
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <section className="memo-mini-calendar" aria-label="随记月历" aria-busy={loading}>
      <div className="memo-calendar-heading">
        <strong>{monthLabel(month)}</strong>
        <div className="memo-calendar-nav">
          <button
            type="button"
            aria-label="上个月"
            onClick={() => onMonthChange(addMonths(month, -1))}
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            aria-label="下个月"
            onClick={() => onMonthChange(addMonths(month, 1))}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
      <div className="memo-weekdays" aria-hidden="true">
        {weekdayLabels().map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div
        ref={gridRef}
        className="memo-mini-grid"
        role="grid"
        aria-label={`${monthLabel(month)}随记月历`}
        onKeyDown={moveFocus}
      >
        {cells.map((cell) => {
          const count = counts[cell.date] ?? 0;
          return (
            <button
              type="button"
              role="gridcell"
              key={cell.date}
              data-date={cell.date}
              tabIndex={cell.date === focusDate ? 0 : -1}
              className={`memo-mini-day ${cell.inMonth ? "" : "is-outside"} ${cell.isToday ? "is-today" : ""} ${cell.date === selectedDate ? "is-selected" : ""}`.trim()}
              aria-label={countLabel(cell.date, count)}
              aria-pressed={cell.date === selectedDate}
              aria-current={cell.isToday ? "date" : undefined}
              onClick={() => onSelectDate(cell.date === selectedDate ? null : cell.date)}
            >
              <span>{cell.day}</span>
              {count > 0 && <i aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      {selectedDate && (
        <button type="button" className="memo-calendar-clear" onClick={() => onSelectDate(null)}>
          <RotateCcw size={14} aria-hidden="true" />
          清除日期
        </button>
      )}
      {error && (
        <p className="memo-facets-error" role="status">
          {error}
        </p>
      )}
    </section>
  );
}

export function MonthCalendar({
  month,
  counts,
  selectedDate,
  loading,
  error,
  onMonthChange,
  onSelectDate,
}: {
  month: string;
  counts: CalendarCounts;
  selectedDate: string | null;
  loading: boolean;
  error?: string | null;
  onMonthChange: (month: string) => void;
  onSelectDate: (date: string | null) => void;
}) {
  const cells = useMemo(() => monthCells(month), [month]);
  const gridRef = useRef<HTMLDivElement>(null);
  const today = localDateKey(Date.now());
  const focusDate = selectedDate ?? today;

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = (event.target as HTMLElement).dataset.date;
    if (!current) return;
    const date = new Date(`${current}T12:00:00`);
    let next: string | null = null;
    if (event.key === "ArrowLeft") (date.setDate(date.getDate() - 1), (next = localDateKey(date)));
    if (event.key === "ArrowRight") (date.setDate(date.getDate() + 1), (next = localDateKey(date)));
    if (event.key === "ArrowUp") (date.setDate(date.getDate() - 7), (next = localDateKey(date)));
    if (event.key === "ArrowDown") (date.setDate(date.getDate() + 7), (next = localDateKey(date)));
    if (event.key === "Home") next = `${month}-01`;
    if (event.key === "End") {
      const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
      next = localDateKey(end);
    }
    if (!next) return;
    const target = gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`);
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <section className="memo-month-calendar" aria-label="随记日历" aria-busy={loading}>
      <div className="memo-month-heading">
        <div className="memo-calendar-nav">
          <button
            type="button"
            aria-label="上个月"
            onClick={() => onMonthChange(addMonths(month, -1))}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            type="button"
            aria-label="下个月"
            onClick={() => onMonthChange(addMonths(month, 1))}
          >
            <ChevronRight size={17} />
          </button>
        </div>
        <h2>{monthLabel(month)}</h2>
        <button
          type="button"
          className="memo-calendar-today"
          onClick={() => {
            const next = currentMonthKey();
            onMonthChange(next);
            onSelectDate(localDateKey(Date.now()));
          }}
        >
          今天
        </button>
      </div>
      <div className="memo-weekdays memo-month-weekdays" aria-hidden="true">
        {weekdayLabels().map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div
        ref={gridRef}
        className="memo-month-grid"
        role="grid"
        aria-label={`${monthLabel(month)}随记日历`}
        onKeyDown={moveFocus}
      >
        {cells.map((cell) => {
          const count = counts[cell.date] ?? 0;
          return (
            <button
              type="button"
              role="gridcell"
              key={cell.date}
              data-date={cell.date}
              tabIndex={cell.date === focusDate ? 0 : -1}
              className={`memo-month-day ${cell.inMonth ? "" : "is-outside"} ${cell.isToday ? "is-today" : ""} ${cell.date === selectedDate ? "is-selected" : ""}`.trim()}
              aria-label={countLabel(cell.date, count)}
              aria-pressed={cell.date === selectedDate}
              aria-current={cell.isToday ? "date" : undefined}
              onClick={() => onSelectDate(cell.date)}
            >
              <span className="memo-month-day-number">{cell.day}</span>
              {count > 0 && <span className="memo-month-day-count">{count}</span>}
            </button>
          );
        })}
      </div>
      {error && (
        <p className="memo-facets-error" role="status">
          {error}
        </p>
      )}
    </section>
  );
}
