/** Cloudflare D1 adapter used by the request handlers. */
export type D1Value = string | number | null | Uint8Array;

export type D1Result<T = unknown> = {
  success: boolean;
  results?: T[];
  meta?: { changes?: number; last_row_id?: number };
  error?: string;
};

export type D1PreparedStatement = {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};

export type D1Binding = {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<D1Result>;
};

export type SqliteRunResult = { changes: number; results?: Record<string, unknown>[] };
export type BatchStatement = { sql: string; values?: D1Value[] };
export type TestSqliteDatabase = import("bun:sqlite").Database & {
  batch(statements: BatchStatement[]): Promise<SqliteRunResult[]>;
};

type Database = CloudflareDatabaseAdapter | TestSqliteDatabase;

class D1Query {
  constructor(
    private readonly binding: D1Binding,
    private readonly sql: string,
  ) {}

  async get<T = Record<string, unknown>>(...values: D1Value[]) {
    const result = await this.binding
      .prepare(this.sql)
      .bind(...values)
      .first<T>();
    return result;
  }

  async all<T = Record<string, unknown>>(...values: D1Value[]) {
    const result = await this.binding
      .prepare(this.sql)
      .bind(...values)
      .all<T>();
    if (!result.success) throw new Error(result.error ?? "D1 query failed");
    return result.results ?? [];
  }

  async run(...values: D1Value[]): Promise<SqliteRunResult> {
    const result = await this.binding
      .prepare(this.sql)
      .bind(...values)
      .run();
    if (!result.success) throw new Error(result.error ?? "D1 query failed");
    return { changes: Number(result.meta?.changes ?? 0) };
  }

  async iterate<T = Record<string, unknown>>(...values: D1Value[]) {
    return this.all<T>(...values);
  }
}

export class CloudflareDatabaseAdapter {
  constructor(readonly binding: D1Binding) {}

  query(sql: string) {
    return new D1Query(this.binding, sql);
  }

  async batch(statements: BatchStatement[]) {
    if (statements.length === 0) return [] as SqliteRunResult[];
    const results = await this.binding.batch(
      statements.map(({ sql, values = [] }) => this.binding.prepare(sql).bind(...values)),
    );
    return results.map((result) => {
      if (!result.success) throw new Error(result.error ?? "D1 batch failed");
      return {
        changes: Number(result.meta?.changes ?? 0),
        ...(result.results ? { results: result.results as Record<string, unknown>[] } : {}),
      };
    });
  }
}

/** Kept as a source-compatible name while route modules are migrated. */
export type SqliteDatabase = Database;

const adapters = new WeakMap<object, CloudflareDatabaseAdapter>();

export function databaseFromBinding(binding: D1Binding) {
  const key = binding as object;
  let database = adapters.get(key);
  if (!database) {
    database = new CloudflareDatabaseAdapter(binding);
    adapters.set(key, database);
  }
  return database;
}
