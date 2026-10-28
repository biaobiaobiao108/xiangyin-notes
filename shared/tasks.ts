import { marked } from "marked";

export type MarkdownTask = {
  text: string;
  completed: boolean;
  ordinal: number;
};

type MarkdownToken = {
  type?: string;
  raw?: string;
  text?: string;
  task?: boolean;
  checked?: boolean;
  tokens?: MarkdownToken[];
  items?: MarkdownToken[];
};

function collectInlineText(tokens: MarkdownToken[] | undefined): string {
  if (!tokens) return "";
  return tokens
    .map((token) => {
      if (token.type === "checkbox" || token.type === "list" || token.type === "list_item")
        return "";
      if (token.type === "br") return "\n";
      if (token.tokens) return collectInlineText(token.tokens);
      if (token.type === "html") return "";
      return decodeHtmlEntities(token.text ?? "");
    })
    .join("");
}

// Keep this order aligned with Tiptap's Markdown text parser. Decoding &amp; last
// preserves doubly encoded input such as `&amp;lt;` as the literal `&lt;`.
function decodeHtmlEntities(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function taskItemText(item: MarkdownToken) {
  const firstParagraph = item.tokens?.find((token) => token.type === "paragraph");
  const text = firstParagraph
    ? collectInlineText(firstParagraph.tokens)
    : collectInlineText(item.tokens);
  return text.replace(/\s+/gu, " ").trim();
}

/** Extract Markdown task items in document order, excluding fenced code and inline examples. */
export function extractMarkdownTasks(markdown: string): MarkdownTask[] {
  const tokens = marked.lexer(markdown) as unknown as MarkdownToken[];
  const tasks: MarkdownTask[] = [];

  const visit = (children: MarkdownToken[]) => {
    for (const token of children) {
      if (token.type === "list") {
        for (const item of token.items ?? []) {
          if (item.task) {
            tasks.push({
              text: taskItemText(item),
              completed: Boolean(item.checked),
              ordinal: tasks.length,
            });
          }
          if (item.tokens) visit(item.tokens);
        }
        continue;
      }
      if (token.tokens) visit(token.tokens);
    }
  };

  visit(tokens);
  return tasks;
}

/** Locate a task marker in source order, excluding fenced and indented code. */
export function findMarkdownTaskMarker(markdown: string, ordinal: number) {
  const lines = markdown.match(/[^\n]*(?:\n|$)/gu) ?? [];
  let offset = 0;
  const markers: Array<{ start: number; end: number; checked: boolean; sentinel: string }> = [];
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const augmented: string[] = [];

  for (const lineWithEnding of lines) {
    const line = lineWithEnding.replace(/\r?\n$/u, "");
    const match = /^(?:[ \t]{0,3}>[ \t]?)*[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\]/u.exec(line);
    if (match) {
      const markerStart = match[0].lastIndexOf("[");
      const markerEnd = markerStart + 3;
      let insertion = markerEnd;
      while (insertion < line.length && /[ \t]/u.test(line[insertion]!)) insertion += 1;
      const sentinel = `TASKPOS${nonce}${markers.length}END`;
      markers.push({
        start: offset + markerStart,
        end: offset + markerEnd,
        checked: match[1]!.toLowerCase() === "x",
        sentinel,
      });
      augmented.push(
        lineWithEnding.slice(0, insertion) + sentinel + " " + lineWithEnding.slice(insertion),
      );
    } else {
      augmented.push(lineWithEnding);
    }
    offset += lineWithEnding.length;
  }

  const parsedTasks = extractMarkdownTasks(augmented.join(""));
  const target = parsedTasks[ordinal];
  if (!target) return null;
  const matchingMarkers = markers.filter((marker) => target.text.includes(marker.sentinel));
  if (matchingMarkers.length !== 1) return null;
  const marker = matchingMarkers[0]!;
  const textWithoutSentinel = target.text.replace(marker.sentinel, "").replace(/\s+/gu, " ").trim();
  const originalTask = extractMarkdownTasks(markdown)[ordinal];
  if (
    !originalTask ||
    textWithoutSentinel !== originalTask.text ||
    target.completed !== originalTask.completed
  )
    return null;
  return { start: marker.start, end: marker.end, checked: marker.checked };
}
