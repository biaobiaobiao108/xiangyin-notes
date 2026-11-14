import { createXiangyingMarked } from "../shared/markdown-lexer";

const marked = createXiangyingMarked();
const PARAGRAPH =
  "## 标题\n\n这是一段中文正文，包含 **加粗** 和 [链接](https://example.com) 以及 `code`。\n\n- 项目一\n- 项目二\n\n";

function markdownFixture(length: number) {
  return PARAGRAPH.repeat(Math.ceil(length / PARAGRAPH.length)).slice(0, length);
}

function measure(label: string, operation: () => void) {
  const startedAt = performance.now();
  operation();
  console.log(`${label}: ${Math.round(performance.now() - startedAt)}ms`);
}

console.log("Markdown preview");
for (const length of [50_000, 200_000, 500_000, 1_000_000]) {
  const markdown = markdownFixture(length);
  measure(`${length.toLocaleString("en-US")} chars`, () => {
    marked.parse(markdown);
  });
}

console.log("Memo facets");
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
for (const rows of [1_000, 10_000, 50_000]) {
  measure(`${rows.toLocaleString("en-US")} rows`, () => {
    const counts = new Map<string, number>();
    for (let index = 0; index < rows; index += 1) {
      const parts = formatter.formatToParts(new Date(1_767_225_600_000 + index * 60_000));
      const value = (type: "year" | "month" | "day") =>
        parts.find((part) => part.type === type)?.value ?? "";
      const date = `${value("year")}-${value("month")}-${value("day")}`;
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
  });
}

export {};
