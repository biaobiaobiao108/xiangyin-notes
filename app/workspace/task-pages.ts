import type { TaskSummary } from "../../shared/types";

type TaskPage = { tasks: TaskSummary[]; total?: number; nextCursor: string | null };

/** Reload the already visible range, keeping the server's cursor for the next page. */
export async function reloadTaskPages(
  fetchPage: (cursor: string | undefined, limit: number) => Promise<TaskPage>,
  loadedCount: number,
) {
  const tasks: TaskSummary[] = [];
  let cursor: string | undefined;
  let total = 0;
  let nextCursor: string | null = null;
  do {
    const page = await fetchPage(cursor, Math.min(200, Math.max(100, loadedCount - tasks.length)));
    if (cursor === undefined) total = page.total ?? page.tasks.length;
    tasks.push(...page.tasks);
    nextCursor = page.nextCursor;
    cursor = nextCursor ?? undefined;
  } while (nextCursor && tasks.length < loadedCount);
  return { tasks, total, nextCursor };
}
