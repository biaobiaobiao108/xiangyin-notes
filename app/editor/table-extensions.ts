import { renderTableToMarkdown, Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import type { JSONContent, MarkdownRendererHelpers, MarkdownToken } from "@tiptap/core";

const WIDTH_DASH_OFFSET = 5;
const MIN_WIDTH_DASHES = 13;
const MIN_COLUMN_WIDTH = 96;
const PIXELS_PER_WIDTH_DASH = 12;

// GFM accepts any delimiter length. Long runs preserve editable column widths
// in Markdown without adding HTML or changing the table's visible content.
function readColumnWidthsFromDelimiter(markdown: string) {
  const delimiter = markdown.replace(/\r/gu, "").split("\n")[1];
  if (!delimiter) return null;

  const cells = delimiter.trim().replace(/^\||\|$/gu, "").split("|");
  const dashCounts = cells.map((cell) => (cell.match(/-/gu) ?? []).length);
  if (dashCounts.length === 0 || dashCounts.some((count) => count < MIN_WIDTH_DASHES)) return null;

  return dashCounts.map((count) => Math.max(MIN_COLUMN_WIDTH, (count - WIDTH_DASH_OFFSET) * PIXELS_PER_WIDTH_DASH));
}

function renderTableMarkdownWithWidths(node: JSONContent, helpers: MarkdownRendererHelpers) {
  const markdown = renderTableToMarkdown(node, helpers);
  const firstRow = node.content?.[0];
  const cells = firstRow?.content ?? [];
  const widths = cells.map((cell) => {
    const value = Array.isArray(cell.attrs?.colwidth) ? Number(cell.attrs.colwidth[0]) : 0;
    return Number.isFinite(value) && value > 0 ? value : null;
  });

  if (!widths.some((width) => width !== null)) return markdown;

  const leadingNewline = markdown.startsWith("\n");
  const lines = (leadingNewline ? markdown.slice(1) : markdown).split("\n");
  const delimiter = lines[1];
  if (!delimiter) return markdown;

  const delimiterCells = delimiter.trim().replace(/^\||\|$/gu, "").split("|");
  const encodedDelimiter = widths.map((width, index) => {
    const source = delimiterCells[index] ?? "---";
    const hasLeadingAlignment = /^\s*:/u.test(source);
    const hasTrailingAlignment = /:\s*$/u.test(source);
    const sourceWidth = (source.match(/-/gu) ?? []).length * PIXELS_PER_WIDTH_DASH;
    const effectiveWidth = width ?? Math.max(MIN_COLUMN_WIDTH, sourceWidth);
    const dashCount = Math.max(MIN_WIDTH_DASHES, Math.round(effectiveWidth / PIXELS_PER_WIDTH_DASH) + WIDTH_DASH_OFFSET);
    return `${hasLeadingAlignment ? ":" : ""}${"-".repeat(dashCount)}${hasTrailingAlignment ? ":" : ""}`;
  });

  lines[1] = `| ${encodedDelimiter.join(" | ")} |`;
  return `${leadingNewline ? "\n" : ""}${lines.join("\n")}`;
}

type MarkdownTableToken = MarkdownToken & { raw?: string };

const ResizableTable = Table.extend({
  parseMarkdown(token, helpers) {
    const table = Table.config.parseMarkdown!(token, helpers) as JSONContent;
    const widths = readColumnWidthsFromDelimiter((token as MarkdownTableToken).raw ?? "");
    if (!widths || !table.content) return table;

    table.content.forEach((row) => {
      row.content?.forEach((cell, index) => {
        if (widths[index] === undefined) return;
        cell.attrs = { ...cell.attrs, colwidth: [widths[index]] };
      });
    });

    return table;
  },

  renderMarkdown(node, helpers) {
    return renderTableMarkdownWithWidths(node, helpers);
  },
});

/**
 * The editor and read-only renderer share the same GFM table schema. Keeping
 * each cell to one paragraph lets Markdown represent every supported cell.
 */
export function createTableExtensions() {
  return [
    ResizableTable.configure({ resizable: true, renderWrapper: true, cellMinWidth: MIN_COLUMN_WIDTH, handleWidth: 8 }),
    TableRow,
    TableCell.extend({ content: "paragraph" }),
    TableHeader.extend({ content: "paragraph" }),
  ];
}
