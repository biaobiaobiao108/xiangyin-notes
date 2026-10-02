export function imageExportFilename(title: string, page?: number) {
  const safe = title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/u, "").trim().slice(0, 80) || "未命名笔记";
  return `${safe}${page === undefined ? "" : `-${String(page + 1).padStart(3, "0")}`}.png`;
}

