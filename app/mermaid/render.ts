import {
  MERMAID_SOURCE_LIMIT,
  type DiagramFailure,
  type DiagramLayout,
  type DiagramRequest,
  type DiagramResponse,
  type DiagramResult,
} from "./protocol";

const RENDER_TIMEOUT_MS = 5_000;
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
  return (
    !(reason instanceof DiagramError) ||
    ["worker", "timeout", "render"].includes(reason.failure.code)
  );
}

type Job = {
  request: DiagramRequest;
  signal: AbortSignal;
  resolve: (result: DiagramResult) => void;
  reject: (reason: unknown) => void;
  abort: () => void;
};

const queue: Job[] = [];
let worker: Worker | undefined;
let active: Job | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;

function takeActive() {
  clearTimeout(timeout);
  const job = active;
  active = undefined;
  job?.signal.removeEventListener("abort", job.abort);
  return job;
}

function resetWorker(reason: unknown) {
  worker?.terminate();
  worker = undefined;
  takeActive()?.reject(reason);
  pump();
}

function pump() {
  while (!active && queue.length) {
    const job = queue.shift()!;
    active = job;
    try {
      if (!worker) {
        const instance = new Worker("/mermaid-worker.js", { type: "module" });
        worker = instance;
        instance.onmessage = ({ data }: MessageEvent<DiagramResponse>) => {
          if (worker !== instance) return;
          const completed = takeActive();
          if ("result" in data) completed?.resolve(data.result);
          else completed?.reject(new DiagramError(data.failure));
          pump();
        };
        instance.onerror = (event) => {
          if (worker !== instance) return;
          event.preventDefault();
          const error = new DiagramError({
            code: "worker",
            message: "图表渲染器加载失败，请重试",
            line: 0,
            column: 0,
          });
          const waiting = queue.splice(0);
          resetWorker(error);
          for (const pending of waiting) {
            pending.signal.removeEventListener("abort", pending.abort);
            pending.reject(error);
          }
        };
      }
      worker.postMessage(job.request);
      timeout = setTimeout(() => {
        resetWorker(
          new DiagramError({ code: "timeout", message: "图表渲染超时", line: 0, column: 0 }),
        );
      }, RENDER_TIMEOUT_MS);
    } catch (reason) {
      takeActive()?.reject(reason);
      worker?.terminate();
      worker = undefined;
    }
  }
}

export async function renderDiagram(request: DiagramRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  if (request.source.length > MERMAID_SOURCE_LIMIT) {
    throw new DiagramError({
      code: "limit",
      message: "图表源码超过 50,000 字符",
      line: 0,
      column: 0,
    });
  }
  return new Promise<DiagramResult>((resolve, reject) => {
    const job: Job = {
      request,
      signal,
      resolve,
      reject,
      abort: () => {
        // Keep a running render if other diagrams are waiting. Its result will be discarded.
        if (active === job) {
          if (!queue.length) resetWorker(signal.reason);
        } else {
          const index = queue.indexOf(job);
          if (index >= 0) queue.splice(index, 1);
        }
        reject(signal.reason);
      },
    };
    signal.addEventListener("abort", job.abort, { once: true });
    queue.push(job);
    pump();
  });
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
