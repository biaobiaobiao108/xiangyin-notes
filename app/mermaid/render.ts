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

export function diagramImage(result: DiagramResult, container: HTMLElement) {
  const svg = new DOMParser().parseFromString(result.svg, "image/svg+xml").documentElement;
  if (svg.namespaceURI !== SVG_NAMESPACE || svg.localName !== "svg") {
    throw new Error("Invalid diagram SVG");
  }
  const style = getComputedStyle(container);
  const colors = Object.entries(colorRoles)
    .map(([role, token]) => `--pele-${role}:${style.getPropertyValue(token).trim()};`)
    .join("");
  const colorScheme = style.colorScheme === "dark" ? "dark" : "light";
  svg.setAttribute(
    "style",
    `${svg.getAttribute("style") ?? ""};color-scheme:${colorScheme};${colors}`,
  );
  const title = svg.querySelector("title")?.textContent?.trim();
  const description = svg.querySelector("desc")?.textContent?.trim();
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }),
  );
  return { url, alt: [title, description].filter(Boolean).join("。") || "Mermaid 图表" };
}
