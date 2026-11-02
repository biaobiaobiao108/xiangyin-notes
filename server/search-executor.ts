import type { SqlValue } from "./core";
import type { SqliteDatabase } from "./db";

export type SearchRequest = {
  sql: string;
  params: SqlValue[];
  countSql?: string | null;
  countParams?: SqlValue[];
};

export type SearchResult = {
  rows: unknown[];
  count: number | null;
};

export interface SearchExecutor {
  execute(request: SearchRequest): Promise<SearchResult>;
  close(): Promise<void>;
}

type WorkerRequest =
  | (SearchRequest & {
      id: number;
      databasePath: string;
    })
  | { id: number; close: true };

type WorkerResponse =
  | { id: number; ok: true; rows: unknown[]; count: number | null }
  | { id: number; ok: true; closed: true }
  | { id: number; ok: false; error: string };

const WORKER_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./search-worker.ts" : "./search-worker.js",
  import.meta.url,
);
const QUERY_TIMEOUT_MS = 60_000;

class SearchWorkerUnavailableError extends Error {}

export function executeSearchDirect(
  database: SqliteDatabase,
  request: SearchRequest,
): SearchResult {
  const count = request.countSql
    ? Number(
        (
          database.query(request.countSql).get(...(request.countParams ?? [])) as {
            count: number;
          } | null
        )?.count ?? 0,
      )
    : null;
  const rows = database.query(request.sql).all(...request.params) as unknown[];
  return { rows, count };
}

export async function executeSearch(
  database: SqliteDatabase,
  executor: SearchExecutor | undefined,
  request: SearchRequest,
) {
  if (!executor) return executeSearchDirect(database, request);
  return executor.execute(request);
}

type PendingRequest = {
  resolve: (result: SearchResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ManagedWorker = Worker & {
  unref(): void;
  onclose: ((event: CloseEvent) => void) | null;
};

class WorkerSearchExecutor implements SearchExecutor {
  private worker: ManagedWorker | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(
    private database: SqliteDatabase,
    private databasePath: string,
  ) {}

  async execute(request: SearchRequest) {
    try {
      return await this.runInWorker(request);
    } catch (error) {
      if (!(error instanceof SearchWorkerUnavailableError)) throw error;
      console.warn("[search] worker unavailable; falling back to main thread", error);
      return executeSearchDirect(this.database, request);
    }
  }

  close() {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    this.failAll(new SearchWorkerUnavailableError("搜索线程已关闭"));
    if (!worker) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        resolve();
      };
      const timer = setTimeout(done, 1_000);
      worker.onmessage = () => done();
      worker.onerror = () => done();
      worker.onclose = () => done();
      worker.postMessage({ id: this.nextId++, close: true } satisfies WorkerRequest);
    });
  }

  private runInWorker(request: SearchRequest) {
    return new Promise<SearchResult>((resolve, reject) => {
      if (this.closed) {
        reject(new SearchWorkerUnavailableError("搜索线程已关闭"));
        return;
      }
      const worker = this.ensureWorker();
      const id = this.nextId++;
      const timer = setTimeout(() => {
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        this.failAll(new SearchWorkerUnavailableError("搜索查询超时"));
      }, QUERY_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({
          id,
          databasePath: this.databasePath,
          ...request,
        } satisfies WorkerRequest);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new SearchWorkerUnavailableError(
            error instanceof Error ? error.message : "搜索线程不可用",
          ),
        );
      }
    });
  }

  private ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(WORKER_URL) as ManagedWorker;
    worker.unref();
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (!response.ok) pending.reject(new Error(response.error));
      else if ("closed" in response) pending.reject(new Error("搜索线程已关闭"));
      else pending.resolve({ rows: response.rows, count: response.count });
    };
    worker.onerror = (event) => {
      if (this.worker === worker) this.worker = null;
      this.failAll(new SearchWorkerUnavailableError(event.message || "搜索线程发生错误"));
    };
    worker.onclose = () => {
      if (this.closed || this.worker !== worker) return;
      this.worker = null;
      this.failAll(new SearchWorkerUnavailableError("搜索线程已退出"));
    };
    this.worker = worker;
    return worker;
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function createSearchExecutor(database: SqliteDatabase): SearchExecutor | undefined {
  const path = database.filename;
  if (!path || path === ":memory:") return undefined;
  return new WorkerSearchExecutor(database, path);
}
