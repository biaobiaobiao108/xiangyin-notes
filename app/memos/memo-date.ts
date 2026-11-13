const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const;

export function localDateKey(value: number | Date) {
  const date = typeof value === "number" ? new Date(value) : value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function currentMonthKey(value: number | Date = Date.now()) {
  return localDateKey(value).slice(0, 7);
}

export function parseLocalDate(key: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(key);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return localDateKey(date) === key ? date : null;
}

export function dayBounds(key: string) {
  const date = parseLocalDate(key);
  if (!date) return null;
  const from = date.getTime();
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { from, to: next.getTime() };
}

export function monthBounds(month: string) {
  const match = /^(\d{4})-(\d{2})$/u.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const start = new Date(year, monthIndex, 1);
  if (start.getFullYear() !== year || start.getMonth() !== monthIndex) return null;
  const next = new Date(year, monthIndex + 1, 1);
  return {
    from: start.getTime(),
    to: next.getTime(),
    year,
    monthIndex,
  };
}

export function addMonths(month: string, delta: number) {
  const bounds = monthBounds(month);
  if (!bounds) return currentMonthKey();
  return currentMonthKey(new Date(bounds.year, bounds.monthIndex + delta, 1));
}

export function monthLabel(month: string) {
  const bounds = monthBounds(month);
  return bounds ? `${bounds.year}年${bounds.monthIndex + 1}月` : month;
}

export type CalendarCell = {
  date: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
};

export function buildMonthCells(month: string) {
  const bounds = monthBounds(month);
  if (!bounds) return [];
  const firstWeekday = (new Date(bounds.year, bounds.monthIndex, 1).getDay() + 6) % 7;
  const gridStart = new Date(bounds.year, bounds.monthIndex, 1 - firstWeekday);
  const today = localDateKey(Date.now());
  return Array.from({ length: 42 }, (_, index): CalendarCell => {
    const date = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + index,
    );
    const key = localDateKey(date);
    return {
      date: key,
      day: date.getDate(),
      inMonth: date.getMonth() === bounds.monthIndex,
      isToday: key === today,
    };
  });
}

export function weekdayLabels() {
  return WEEKDAY_LABELS;
}

export function timelineDateLabel(key: string, now = Date.now()) {
  const today = localDateKey(now);
  if (key === today) return "今天";
  if (key === localDateKey(now - DAY_MS)) return "昨天";
  const date = parseLocalDate(key);
  if (!date) return key;
  const includeYear = date.getFullYear() !== new Date(now).getFullYear();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(includeYear ? { year: "numeric" } : {}),
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

export function dayHeading(key: string) {
  const date = parseLocalDate(key);
  if (!date) return key;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

export function timeLabel(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

export function selectedDayCreateTime(date: string, now = Date.now()) {
  if (date === localDateKey(now)) return now;
  const target = parseLocalDate(date);
  if (!target) return now;
  const current = new Date(now);
  return new Date(
    target.getFullYear(),
    target.getMonth(),
    target.getDate(),
    current.getHours(),
    current.getMinutes(),
    current.getSeconds(),
    current.getMilliseconds(),
  ).getTime();
}

export function groupedByLocalDate<T extends { createdAt: number }>(items: T[]) {
  const groups: Array<{ date: string; items: T[] }> = [];
  for (const item of items) {
    const date = localDateKey(item.createdAt);
    const current = groups.at(-1);
    if (current?.date === date) current.items.push(item);
    else groups.push({ date, items: [item] });
  }
  return groups;
}

export function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
