import { createUuid } from "../uuid";

export type MemoEditDraft = {
  markdown: string;
  version: number;
  conflict?: boolean;
};

type StoredMemoEditDraft = MemoEditDraft & { key: string; updatedAt: number; serialized: string };

export function memoEditDraftKey(memoId: string) {
  return `xiangying:memo-edit:${memoId}`;
}

function draftKeys(memoId: string) {
  const base = memoEditDraftKey(memoId);
  const keys = [base];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(`${base}:`)) keys.push(key);
  }
  return keys;
}

export function readMemoEditDraft(memoId: string): StoredMemoEditDraft | null {
  try {
    let latest: StoredMemoEditDraft | null = null;
    for (const key of draftKeys(memoId)) {
      const serialized = localStorage.getItem(key);
      if (!serialized) continue;
      let value;
      try {
        value = JSON.parse(serialized);
      } catch {
        continue;
      }
      if (
        !value ||
        typeof value.markdown !== "string" ||
        !Number.isSafeInteger(value.version) ||
        (value.conflict !== undefined && typeof value.conflict !== "boolean")
      )
        continue;
      const updatedAt = Number.isSafeInteger(value.updatedAt) ? value.updatedAt : 0;
      if (!latest || updatedAt >= latest.updatedAt) {
        latest = {
          key,
          serialized,
          updatedAt,
          markdown: value.markdown,
          version: value.version,
          ...(value.conflict ? { conflict: true } : {}),
        };
      }
    }
    return latest;
  } catch {
    return null;
  }
}

export function beginMemoDraftSession(memoId: string) {
  const initial = readMemoEditDraft(memoId);
  const key = `${memoEditDraftKey(memoId)}:${createUuid()}`;
  return {
    initial,
    write(draft: MemoEditDraft | null) {
      try {
        if (draft) localStorage.setItem(key, JSON.stringify({ ...draft, updatedAt: Date.now() }));
        else localStorage.removeItem(key);
      } catch {
        if (draft?.conflict)
          throw new Error("本地存储不可用，无法保留冲突草稿；请先复制草稿内容再继续");
      }
    },
    clear({ includeInitial = false } = {}) {
      try {
        localStorage.removeItem(key);
        if (includeInitial && initial && localStorage.getItem(initial.key) === initial.serialized)
          localStorage.removeItem(initial.key);
      } catch {}
    },
  };
}

export function hasMemoEditDraft(memoId: string) {
  try {
    return draftKeys(memoId).some((key) => Boolean(localStorage.getItem(key)));
  } catch {
    throw new Error("本地存储不可用，无法确认随记草稿状态");
  }
}
