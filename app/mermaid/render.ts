import { MERMAID_SOURCE_LIMIT, type DiagramLayout, type DiagramResult } from "./protocol";

type DiagramFailure = { code: string; message: string; line: number; column: number };

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const colorRoles = {
  bg: "--surface",
  fg: "--ink",
  muted: "--quiet-ink",
  line: "--quiet-ink",
  surface: "--surface-muted",
  "surface-alt": "--accent-soft",
  border: "--muted",
  accent: "--accent",
  critical: "--danger",
} as const;

class DiagramError extends Error {
  constructor(readonly failure: DiagramFailure) {
    super(failure.message);
  }
}

export function diagramErrorMessage(reason: unknown) {
  if (!(reason instanceof DiagramError)) return "图表暂时无法渲染";
  const { code, line, column, message } = reason.failure;
  const location = line > 0 ? `第 ${line} 行${column > 0 ? `第 ${column} 列` : ""} · ` : "";
  const summary =
    code === "unsupported-diagram"
      ? "无法识别图表类型"
      : code === "syntax"
        ? "Mermaid 语法有误"
        : message;
  return `${location}${summary.slice(0, 240)}`;
}

export function canRetryDiagram(reason: unknown) {
  return !(reason instanceof DiagramError) || reason.failure.code === "render";
}

export async function renderDiagram(
  { source, width, fontFamily, fontFamilyMono }: DiagramLayout & { source: string },
  signal: AbortSignal,
): Promise<DiagramResult> {
  signal.throwIfAborted();
  if (source.length > MERMAID_SOURCE_LIMIT) {
    throw new DiagramError({
      code: "limit",
      message: "图表源码超过 50,000 字符",
      line: 0,
      column: 0,
    });
  }

  const { PeleError, render } = await import("pele").catch(() => {
    throw new DiagramError({
      code: "load",
      message: "图表渲染器加载失败，请刷新页面",
      line: 0,
      column: 0,
    });
  });
  signal.throwIfAborted();

  try {
    const diagram = render(source, {
      maxWidth: width,
      fontFamily,
      fontFamilyMono,
      idPrefix: "xiangying-diagram",
      autoDirection: false,
      links: false,
      images: false,
      limit: MERMAID_SOURCE_LIMIT,
      maxEdges: 5_000,
      outputLimit: 4_000_000,
    });
    return { svg: diagram.svg, width: diagram.width, height: diagram.height };
  } catch (error) {
    if (error instanceof PeleError) {
      const { code, message, line, column } = error;
      throw new DiagramError({ code, message, line, column });
    }
    throw new DiagramError({ code: "render", message: "图表渲染失败", line: 0, column: 0 });
  }
}

export function measureDiagram(container: HTMLElement): DiagramLayout {
  const style = getComputedStyle(container);
  return {
    width: Math.max(
      0,
      Math.floor(
        container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      ),
    ),
    fontFamily: style.fontFamily,
    fontFamilyMono: style.getPropertyValue("--font-mono").trim() || "monospace",
  };
}

function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && i + 1 < text.length) {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitFirstComma(text: string): [string, string] | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && i + 1 < text.length) {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }
  }
  return null;
}

function replaceCssFunction(
  value: string,
  fnName: string,
  resolveArgs: (inner: string) => string | null,
): string {
  const token = `${fnName}(`;
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf(token, cursor);
    if (start === -1) {
      result += value.slice(cursor);
      break;
    }
    const open = start + fnName.length;
    const close = findMatchingParen(value, open);
    if (close === -1) {
      result += value.slice(cursor);
      break;
    }
    result += value.slice(cursor, start);
    const inner = value.slice(open + 1, close);
    const replacement = resolveArgs(inner);
    result += replacement ?? value.slice(start, close + 1);
    cursor = close + 1;
  }
  return result;
}

export function resolveLightDark(value: string, isDark: boolean): string {
  if (!value.includes("light-dark(")) return value;
  return replaceCssFunction(value, "light-dark", (inner) => {
    const parts = splitFirstComma(inner);
    if (!parts) return null;
    return resolveLightDark(isDark ? parts[1] : parts[0], isDark);
  });
}

function parseHexColor(hex: string): [number, number, number] | null {
  const match = hex.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const raw = match[1]!;
  if (raw.length === 3) {
    return [
      parseInt(raw[0]! + raw[0]!, 16),
      parseInt(raw[1]! + raw[1]!, 16),
      parseInt(raw[2]! + raw[2]!, 16),
    ];
  }
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ];
}

function toHexByte(value: number) {
  return Math.min(255, Math.max(0, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}

export function normalizeSvgColor(color: string, backgroundHex: string): string {
  const match = color
    .trim()
    .match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+%?))?\s*\)$/i);
  if (!match) return color;
  const r = Number(match[1]);
  const g = Number(match[2]);
  const b = Number(match[3]);
  const alphaRaw = match[4];
  const alpha = alphaRaw
    ? alphaRaw.endsWith("%")
      ? Number(alphaRaw.slice(0, -1)) / 100
      : Number(alphaRaw)
    : 1;
  if (
    !Number.isFinite(r) ||
    !Number.isFinite(g) ||
    !Number.isFinite(b) ||
    !Number.isFinite(alpha)
  ) {
    return color;
  }
  if (alpha >= 1) return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
  const bg = parseHexColor(backgroundHex);
  if (!bg) return color;
  const clamped = Math.min(1, Math.max(0, alpha));
  return `#${toHexByte(r * clamped + bg[0] * (1 - clamped))}${toHexByte(g * clamped + bg[1] * (1 - clamped))}${toHexByte(b * clamped + bg[2] * (1 - clamped))}`;
}

export function resolveCssVars(value: string, vars: Map<string, string>, depth = 0): string {
  if (depth >= 10 || !value.includes("var(")) return value;
  return replaceCssFunction(value, "var", (inner) => {
    const comma = splitFirstComma(inner);
    const name = (comma ? comma[0] : inner).trim();
    const resolved = vars.get(name);
    if (resolved !== undefined && resolved !== "") {
      return resolveCssVars(resolved, vars, depth + 1);
    }
    if (comma) {
      return resolveCssVars(comma[1], vars, depth + 1);
    }
    return null;
  });
}

function splitStyleDeclarations(styleText: string): string[] {
  const declarations: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < styleText.length; i += 1) {
    const ch = styleText[i];
    if (quote) {
      if (ch === "\\" && i + 1 < styleText.length) {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    } else if (ch === ";" && depth === 0) {
      const part = styleText.slice(start, i).trim();
      if (part) declarations.push(part);
      start = i + 1;
    }
  }
  const tail = styleText.slice(start).trim();
  if (tail) declarations.push(tail);
  return declarations;
}

export function diagramImage(result: DiagramResult, container: HTMLElement) {
  const doc = new DOMParser().parseFromString(result.svg, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg.namespaceURI !== SVG_NAMESPACE || svg.localName !== "svg") {
    throw new Error("Invalid diagram SVG");
  }
  const style = getComputedStyle(container);
  const isDark =
    style.colorScheme === "dark" ||
    (style.colorScheme !== "light" &&
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);

  const vars = new Map<string, string>();
  const bgRaw = style.getPropertyValue(colorRoles.bg).trim();
  const bgFallback = isDark ? "#1f2224" : "#faf9f6";
  const bgResolved = bgRaw ? resolveLightDark(bgRaw, isDark) : bgFallback;
  const bgColor = normalizeSvgColor(bgResolved, bgFallback);
  for (const [role, token] of Object.entries(colorRoles)) {
    const raw = style.getPropertyValue(token).trim();
    if (raw) vars.set(`--pele-${role}`, normalizeSvgColor(resolveLightDark(raw, isDark), bgColor));
  }
  if (style.fontFamily) vars.set("--pele-font", style.fontFamily);
  const fontMono = style.getPropertyValue("--font-mono").trim();
  if (fontMono) vars.set("--pele-font-mono", fontMono);

  for (const decl of splitStyleDeclarations(svg.getAttribute("style") ?? "")) {
    const colon = decl.indexOf(":");
    if (colon === -1) continue;
    const prop = decl.slice(0, colon).trim();
    const val = decl.slice(colon + 1).trim();
    if (prop.startsWith("--") && val) vars.set(prop, val);
  }
  for (const [key, val] of vars) {
    vars.set(key, normalizeSvgColor(resolveLightDark(resolveCssVars(val, vars), isDark), bgColor));
  }

  const resolveValue = (value: string) =>
    normalizeSvgColor(resolveLightDark(resolveCssVars(value, vars), isDark), bgColor);

  const elements: Element[] = [svg, ...Array.from(svg.querySelectorAll("*"))];
  for (const element of elements) {
    for (const attr of Array.from(element.attributes)) {
      if (attr.value.includes("var(") || attr.value.includes("light-dark(")) {
        element.setAttribute(attr.name, resolveValue(attr.value));
      }
    }
    if (element.localName === "rect" && !element.hasAttribute("rx")) {
      const rxMatch = (element.getAttribute("style") ?? "").match(/(?:^|;)\s*rx\s*:\s*([^;]+)/i);
      if (rxMatch?.[1]) {
        element.setAttribute("rx", rxMatch[1].trim().replace(/px$/i, ""));
      }
    }
    if (element.localName === "style" && element.textContent) {
      if (element.textContent.includes("var(") || element.textContent.includes("light-dark(")) {
        element.textContent = resolveValue(element.textContent);
      }
    }
  }

  const bgRect = doc.createElementNS(SVG_NAMESPACE, "rect");
  const viewBox = svg
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/);
  if (viewBox && viewBox.length === 4 && viewBox.every((n) => Number.isFinite(Number(n)))) {
    bgRect.setAttribute("x", viewBox[0]!);
    bgRect.setAttribute("y", viewBox[1]!);
    bgRect.setAttribute("width", viewBox[2]!);
    bgRect.setAttribute("height", viewBox[3]!);
  } else {
    bgRect.setAttribute("width", "100%");
    bgRect.setAttribute("height", "100%");
  }
  bgRect.setAttribute("fill", bgColor);
  svg.insertBefore(bgRect, svg.firstChild);

  const colorScheme = isDark ? "dark" : "light";
  svg.setAttribute("style", `${svg.getAttribute("style") ?? ""};color-scheme:${colorScheme};`);
  const title = svg.querySelector("title")?.textContent?.trim();
  const description = svg.querySelector("desc")?.textContent?.trim();
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }),
  );
  return { url, alt: [title, description].filter(Boolean).join("。") || "Mermaid 图表" };
}
