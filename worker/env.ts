import type { D1Database, Fetcher, KVNamespace } from "@cloudflare/workers-types";

export type Env = {
  DB: D1Database;
  SHARE_KV: KVNamespace;
  ASSETS: Fetcher;
};
