import { Database } from "bun:sqlite";
import { searchContains, searchSnippet } from "./search-text";
import type { SearchRequest, SearchResult } from "./search-executor";

declare var self: Worker;

type WorkerRequest =
  | (SearchRequest & {
      id: number;
      databasePath: string;
    })
  | { id: number; close: true };

type WorkerResponse =
  | ({ id: number; ok: true } & SearchResult)
  | { id: number; ok: true; closed: true }
  | { id: number; ok: false; error: string };

let database: Database | null = null;
let databasePath = "";

function openDatabase(path: string) {
  if (database && databasePath === path) return database;
  database?.close();
  database = new Database(path, { readonly: true });
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -20000;
  `);
  database.function("search_contains", (text: string, term: string) =>
    searchContains(text, term) ? 1 : 0,
  );
  database.function("search_snippet", searchSnippet);
  databasePath = path;
  return database;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if ("close" in message) {
    database?.close();
    database = null;
    databasePath = "";
    self.postMessage({ id: message.id, ok: true, closed: true } satisfies WorkerResponse);
    return;
  }
  const { id, databasePath: path, ...request } = message;
  let response: WorkerResponse;
  try {
    const db = openDatabase(path);
    const result = db.transaction(() => {
      const count = request.countSql
        ? Number(
            (
              db.query(request.countSql).get(...(request.countParams ?? [])) as {
                count: number;
              } | null
            )?.count ?? 0,
          )
        : null;
      const rows = db.query(request.sql).all(...request.params) as unknown[];
      return { rows, count };
    })();
    response = { id, ok: true, ...result };
  } catch (error) {
    response = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : "搜索查询失败",
    };
  }
  self.postMessage(response);
};
