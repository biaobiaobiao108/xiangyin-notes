import { HAN_RE } from "../shared/text-stats";

export { HAN_RE, countTextStats as countEditorText } from "../shared/text-stats";
export type { TextStats as EditorStats } from "../shared/text-stats";

export type OutlineHeading = {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
};

export type OutlineItem = OutlineHeading & {
  id: string;
};

export function getOutlineStructureKey(items: readonly OutlineItem[]): string {
  return JSON.stringify(items.map(({ id, level }) => [id, level]));
}

export function shouldUpdateActiveOutlineFromViewport(
  editorFocused: boolean,
  selectionSynchronized: boolean,
): boolean {
  return !editorFocused || !selectionSynchronized;
}

export type MarkdownHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export function isMarkdownHeadingMarker(text: string): boolean {
  return /^[#＃]{1,6}$/u.test(text);
}

export function parseMarkdownHeadingPrefix(
  text: string,
): { level: MarkdownHeadingLevel; length: number } | null {
  const match = /^([#＃]{1,6})[ \t\u3000]/u.exec(text);
  if (!match) return null;
  return { level: match[1].length as MarkdownHeadingLevel, length: match[0].length };
}

export type MarkdownBlockShortcut =
  | { type: "heading"; level: MarkdownHeadingLevel; length: number }
  | { type: "bulletList"; length: number }
  | { type: "orderedList"; length: number }
  | { type: "blockquote"; length: number }
  | { type: "taskList"; length: number }
  | { type: "codeBlock"; length: number };

export function parseMarkdownBlockShortcut(text: string): MarkdownBlockShortcut | null {
  // A block shortcut is only valid when the whole text before the typed
  // whitespace is the marker. Matching just a prefix can delete the rest of
  // an existing paragraph when executeBlockShortcut removes the block start
  // through the cursor.
  const headingMatch = /^([#＃]{1,6})[ \u3000]$/u.exec(text);
  if (headingMatch) {
    return {
      type: "heading",
      level: headingMatch[1].length as MarkdownHeadingLevel,
      length: headingMatch[0].length,
    };
  }
  const codeBlockMatch = /^(?:```|~~~|｀｀｀)[ \u3000]$/u.exec(text);
  if (codeBlockMatch) {
    return { type: "codeBlock", length: codeBlockMatch[0].length };
  }
  const taskMatch = /^(?:\[(?: |)\]|【[ \u3000]?】)[ \u3000]$/u.exec(text);
  if (taskMatch) {
    return { type: "taskList", length: taskMatch[0].length };
  }
  const bulletMatch = /^[-+*－][ \u3000]$/u.exec(text);
  if (bulletMatch) {
    return { type: "bulletList", length: bulletMatch[0].length };
  }
  const orderedMatch = /^(?:1|１)(?:\.|．|、|。)[ \u3000]$/u.exec(text);
  if (orderedMatch) {
    return { type: "orderedList", length: orderedMatch[0].length };
  }
  const quoteMatch = /^[>＞》〉][ \u3000]$/u.exec(text);
  if (quoteMatch) {
    return { type: "blockquote", length: quoteMatch[0].length };
  }
  return null;
}

function normalizeBlockMarkerLine(line: string): string {
  const indentation = /^ {0,3}/u.exec(line)?.[0] ?? "";
  const content = line.slice(indentation.length);

  const quotePrefix = /^(?:[>＞》〉][ \t\u3000]*)+/u.exec(content);
  if (quotePrefix) {
    const normalizedPrefix = quotePrefix[0].replace(/[＞》〉]/gu, ">").replaceAll("\u3000", " ");
    return `${indentation}${normalizedPrefix}${normalizeBlockMarkerLine(content.slice(quotePrefix[0].length))}`;
  }

  const heading = /^([#＃]{1,6})[ \t\u3000]/u.exec(content);
  if (heading) {
    return `${indentation}${heading[1]!.replaceAll("＃", "#")} ${content.slice(heading[0].length)}`;
  }

  const task = /^(?:\[(?: |)\]|【[ \u3000]?】)[ \t\u3000]/u.exec(content);
  if (task) return `${indentation}- [ ] ${content.slice(task[0].length)}`;

  const bullet = /^([-+*]|－)[ \t\u3000]/u.exec(content);
  if (bullet) {
    const marker = bullet[1] === "－" ? "-" : bullet[1];
    return `${indentation}${marker} ${content.slice(bullet[0].length)}`;
  }

  const ordered = /^((?:1|１)(?:\.|．|、|。))[ \t\u3000]/u.exec(content);
  if (ordered) return `${indentation}1. ${content.slice(ordered[0].length)}`;

  return line;
}

function normalizeFenceMarker(marker: string) {
  return marker.replaceAll("｀", "`").replaceAll("～", "~");
}

/** Converts Chinese block-marker aliases before parsing pasted Markdown, preserving fenced code. */
export function normalizeChineseMarkdownBlockMarkers(markdown: string): string {
  const lines = markdown.split(/(\r\n|\n|\r)/u);
  let openFence: { marker: "`" | "~"; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index]!;

    if (openFence) {
      const closingFence = /^ {0,3}(`{3,}|~{3,}|｀{3,}|～{3,})[ \t\u3000]*$/u.exec(line);
      if (closingFence) {
        const marker = normalizeFenceMarker(closingFence[1]!);
        if (marker[0] === openFence.marker && marker.length >= openFence.length) {
          lines[index] = line.replace(closingFence[1]!, marker);
          openFence = null;
        }
      }
      continue;
    }

    const openingFence = /^ {0,3}(`{3,}|~{3,}|｀{3,}|～{3,})(.*)$/u.exec(line);
    if (openingFence) {
      const marker = normalizeFenceMarker(openingFence[1]!);
      const info = openingFence[2]!;
      if (!(marker.startsWith("`") && info.includes("`"))) {
        lines[index] = line.replace(openingFence[1]!, marker);
        openFence = { marker: marker[0] as "`" | "~", length: marker.length };
        continue;
      }
    }

    lines[index] = normalizeBlockMarkerLine(line);
  }

  return lines.join("");
}

const MARKDOWN_PASTE_RE =
  /(?:^|\n)\s{0,3}(?:[#＃]{1,6}[ \t\u3000]|[-+*－][ \t\u3000]|\d+[.)]\s|(?:1|１)(?:\.|．|、|。)[ \t\u3000]|[>＞》〉][ \t\u3000]|(?:\[[ xX]?\]|【[ \u3000]?】)[ \t\u3000]|```|~~~|｀{3,}|～{3,}|-{3,}\s*$)|(?:\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^\)\n]+\))/u;

export function shouldParseMarkdownPaste(text: string, hasHtml: boolean): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return !hasHtml || MARKDOWN_PASTE_RE.test(text);
}

export function detectLeakedImePrefix(
  blockText: string,
  candidateKey?: string | null,
  committedText?: string | null,
): number | null {
  if (!blockText) return null;

  if (candidateKey && candidateKey.length > 0) {
    const key = candidateKey.startsWith("Key")
      ? candidateKey.slice(3).toLowerCase()
      : candidateKey.startsWith("Digit")
        ? candidateKey.slice(5)
        : candidateKey.toLowerCase();
    const keyLen = key.length;
    if (blockText.length > keyLen && blockText.slice(0, keyLen).toLowerCase() === key) {
      const remainder = blockText.slice(keyLen);
      if (committedText && committedText.length > 0) {
        if (remainder.startsWith(committedText)) {
          return keyLen;
        }
      } else if (HAN_RE.test(remainder[0])) {
        return keyLen;
      }
    }
  }

  if (committedText && committedText.length > 0 && HAN_RE.test(committedText)) {
    if (blockText.length > committedText.length && blockText.endsWith(committedText)) {
      const prefixLen = blockText.length - committedText.length;
      const prefix = blockText.slice(0, prefixLen);
      if (/^[a-zA-Z]$/.test(prefix)) {
        return prefixLen;
      }
    }
  }

  return null;
}

function slugifyHeading(title: string): string {
  const slug = title
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\p{Script=Han}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

export function buildOutlineItems(headings: OutlineHeading[]): OutlineItem[] {
  return headings.map((heading, index) => ({
    ...heading,
    id: `xiangying-heading-${index + 1}-${slugifyHeading(heading.title)}`,
  }));
}
