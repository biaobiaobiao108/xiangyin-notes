import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { Env } from "./env";
import type { ShareSnapshot } from "../shared/types";

const SESSION_COOKIE = "lumen_session";
const SESSION_TTL = 60 * 60 * 24 * 30;
const SHARE_TTL = 60 * 60 * 24 * 7;
const PASSWORD_ITERATIONS = 120_000;
const encoder = new TextEncoder();

type UserRow = {
  id: string;
  username: string;
};

type NoteRow = {
  id: string;
  title: string;
  content_markdown: string;
  notebook_id: string;
  notebook_name: string;
  notebook_color: string;
  is_favorite: number;
  deleted_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
};

type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserRow;
  };
};

const api = new Hono<AppEnv>();

function now() {
  return Math.floor(Date.now() / 1000);
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function createOpaqueToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function digestHex(value: string) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function derivePassword(password: string, saltHex: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(saltHex), iterations: PASSWORD_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

async function hashPassword(password: string) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await derivePassword(password, salt) };
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function cookieValue(header: string | undefined, name: string) {
  const value = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : null;
}

function setSessionCookie(c: Context<AppEnv>, token: string, maxAge = SESSION_TTL) {
  const secure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";
  c.header("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function jsonError(c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 500, code: string, message: string, fields?: Record<string, string>) {
  return c.json({ error: { code, message, ...(fields ? { fields } : {}) } }, status);
}

async function readJson<T>(c: Context<AppEnv>) {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

function validUsername(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{3,32}$/.test(value);
}

function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && value.length <= 128;
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function formatPreview(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\-[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+([,.;!?。！？、，；：])/g, "$1")
    .slice(0, 180);
}

function toNote(row: NoteRow) {
  return {
    id: row.id,
    title: row.title,
    preview: formatPreview(row.content_markdown),
    notebookId: row.notebook_id,
    notebookName: row.notebook_name,
    isFavorite: Boolean(row.is_favorite),
    deletedAt: row.deleted_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFullNote(row: NoteRow) {
  return { ...toNote(row), contentMarkdown: row.content_markdown };
}

async function getCurrentUser(env: Env, request: Request) {
  const session = cookieValue(request.headers.get("Cookie") ?? undefined, SESSION_COOKIE);
  if (!session) return null;
  const tokenHash = await digestHex(session);
  const row = await env.DB.prepare(
    "SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
  ).bind(tokenHash, now()).first<UserRow>();
  return row ?? null;
}

const requireAuth = async (c: Context<AppEnv>, next: Next) => {
  const user = await getCurrentUser(c.env, c.req.raw);
  if (!user) return jsonError(c, 401, "UNAUTHENTICATED", "请先登录");
  c.set("user", user);
  await next();
};

async function getNote(env: Env, userId: string, noteId: string) {
  return env.DB.prepare(
    `SELECT n.id, n.title, n.content_markdown, n.notebook_id, b.name AS notebook_name,
      b.color AS notebook_color, n.is_favorite, n.deleted_at, n.version, n.created_at, n.updated_at
     FROM notes n JOIN notebooks b ON b.id = n.notebook_id
     WHERE n.id = ? AND n.user_id = ?`,
  ).bind(noteId, userId).first<NoteRow>();
}

function buildFtsQuery(query: string) {
  return query
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean)
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join(" AND ");
}

api.use("/api/*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  await next();
});

api.get("/api/bootstrap", async (c) => {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  return c.json({ configured: Number(row?.count ?? 0) > 0 });
});

api.post("/api/setup", async (c) => {
  const payload = await readJson<{ username?: unknown; password?: unknown }>(c);
  if (!payload || !validUsername(payload.username) || !validPassword(payload.password)) {
    return jsonError(c, 400, "INVALID_SETUP", "请输入 3–32 位用户名和至少 12 位密码", {
      username: "用户名只能包含字母、数字、下划线和短横线",
      password: "密码长度至少为 12 位",
    });
  }

  const existing = await c.env.DB.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>();
  if (existing) return jsonError(c, 409, "ALREADY_CONFIGURED", "此空间已经完成初始化");

  const userId = crypto.randomUUID();
  const inboxId = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  const createdAt = now();
  const password = await hashPassword(payload.password);
  const welcomeMarkdown = "## 欢迎来到 Lumen Notes\n\n这是你的第一个笔记。按下 **Ctrl /** 可以打开命令菜单，开始记录你的想法。\n\n- 写下值得保留的东西\n- 用笔记本整理上下文\n- 随时生成一个 7 天有效的只读分享\n";

  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)").bind(userId, payload.username, password.hash, password.salt, createdAt),
    c.env.DB.prepare("INSERT INTO notebooks (id, user_id, name, color, is_system, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)").bind(inboxId, userId, "收件箱", "#d96245", createdAt, createdAt),
    c.env.DB.prepare("INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").bind(noteId, userId, inboxId, "开始记录你的想法", welcomeMarkdown, createdAt, createdAt),
    c.env.DB.prepare("INSERT INTO notes_fts (note_id, title, content) VALUES (?, ?, ?)").bind(noteId, "开始记录你的想法", welcomeMarkdown),
  ]);

  const session = createOpaqueToken();
  await c.env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(await digestHex(session), userId, createdAt, createdAt + SESSION_TTL).run();
  setSessionCookie(c, session);
  return c.json({ user: { id: userId, username: payload.username } }, 201);
});

api.post("/api/auth/login", async (c) => {
  const payload = await readJson<{ username?: unknown; password?: unknown }>(c);
  if (!payload || typeof payload.username !== "string" || typeof payload.password !== "string") {
    return jsonError(c, 400, "INVALID_LOGIN", "请输入用户名和密码");
  }
  const row = await c.env.DB.prepare("SELECT id, username, password_hash, password_salt FROM users WHERE username = ?").bind(payload.username).first<{ id: string; username: string; password_hash: string; password_salt: string }>();
  if (!row || !constantTimeEqual(await derivePassword(payload.password, row.password_salt), row.password_hash)) {
    return jsonError(c, 401, "INVALID_CREDENTIALS", "用户名或密码不正确");
  }
  const session = createOpaqueToken();
  const createdAt = now();
  await c.env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(await digestHex(session), row.id, createdAt, createdAt + SESSION_TTL).run();
  setSessionCookie(c, session);
  return c.json({ user: { id: row.id, username: row.username } });
});

api.post("/api/auth/logout", async (c) => {
  const session = cookieValue(c.req.header("Cookie"), SESSION_COOKIE);
  if (session) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await digestHex(session)).run();
  setSessionCookie(c, "", 0);
  return c.json({ ok: true });
});

api.get("/api/me", requireAuth, (c) => c.json({ user: c.get("user") }));

api.get("/api/notes", requireAuth, async (c) => {
  const user = c.get("user");
  const view = c.req.query("view") ?? "all";
  const query = c.req.query("query")?.slice(0, 80) ?? "";
  const notebookId = c.req.query("notebookId");
  const conditions = ["n.user_id = ?"];
  const params: (string | number)[] = [user.id];
  let from = "notes n JOIN notebooks b ON b.id = n.notebook_id";

  if (view === "trash") conditions.push("n.deleted_at IS NOT NULL");
  else conditions.push("n.deleted_at IS NULL");
  if (view === "inbox") conditions.push("b.is_system = 1");
  if (view === "favorites") conditions.push("n.is_favorite = 1");
  if (view === "shared") {
    conditions.push("EXISTS (SELECT 1 FROM shares s WHERE s.note_id = n.id AND s.revoked_at IS NULL AND s.expires_at > ?)");
    params.push(now());
  }
  if (notebookId) {
    conditions.push("n.notebook_id = ?");
    params.push(notebookId);
  }

  if (query) {
    if (/[\u3400-\u9fff]/u.test(query)) {
      conditions.push("(n.title LIKE ? OR n.content_markdown LIKE ?)");
      params.push(`%${query}%`, `%${query}%`);
    } else {
      const ftsQuery = buildFtsQuery(query);
      if (ftsQuery) {
        from += " JOIN notes_fts ON notes_fts.note_id = n.id";
        conditions.push("notes_fts MATCH ?");
        params.push(ftsQuery);
      }
    }
  }

  const rows = await c.env.DB.prepare(
    `SELECT n.id, n.title, n.content_markdown, n.notebook_id, b.name AS notebook_name,
      b.color AS notebook_color, n.is_favorite, n.deleted_at, n.version, n.created_at, n.updated_at
     FROM ${from} WHERE ${conditions.join(" AND ")} ORDER BY n.updated_at DESC LIMIT 100`,
  ).bind(...params).all<NoteRow>();
  return c.json({ notes: (rows.results ?? []).map(toNote) });
});

api.post("/api/notes", requireAuth, async (c) => {
  const user = c.get("user");
  const payload = await readJson<{ title?: unknown; contentMarkdown?: unknown; notebookId?: unknown }>(c);
  const title = payload?.title === undefined ? "未命名笔记" : payload.title;
  const contentMarkdown = payload?.contentMarkdown === undefined ? "" : payload.contentMarkdown;
  if (!validText(title, 200) || !validText(contentMarkdown, 1_000_000)) return jsonError(c, 413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");

  const notebookId = typeof payload?.notebookId === "string" ? payload.notebookId : (await c.env.DB.prepare("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1").bind(user.id).first<{ id: string }>())?.id;
  if (!notebookId) return jsonError(c, 400, "NO_NOTEBOOK", "没有可用的收件箱");
  const notebook = await c.env.DB.prepare("SELECT id FROM notebooks WHERE id = ? AND user_id = ?").bind(notebookId, user.id).first<{ id: string }>();
  if (!notebook) return jsonError(c, 400, "INVALID_NOTEBOOK", "笔记本不存在");

  const id = crypto.randomUUID();
  const createdAt = now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO notes (id, user_id, notebook_id, title, content_markdown, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").bind(id, user.id, notebookId, title, contentMarkdown, createdAt, createdAt),
    c.env.DB.prepare("INSERT INTO notes_fts (note_id, title, content) VALUES (?, ?, ?)").bind(id, title, contentMarkdown),
  ]);
  const row = await getNote(c.env, user.id, id);
  return c.json({ note: row ? toFullNote(row) : null }, 201);
});

api.get("/api/notes/:id", requireAuth, async (c) => {
  const row = await getNote(c.env, c.get("user").id, c.req.param("id") ?? "");
  return row ? c.json({ note: toFullNote(row) }) : jsonError(c, 404, "NOTE_NOT_FOUND", "笔记不存在");
});

api.patch("/api/notes/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const current = await getNote(c.env, user.id, c.req.param("id") ?? "");
  if (!current) return jsonError(c, 404, "NOTE_NOT_FOUND", "笔记不存在");
  const payload = await readJson<{ version?: unknown; title?: unknown; contentMarkdown?: unknown; notebookId?: unknown; isFavorite?: unknown; deleted?: unknown }>(c);
  if (!payload || !Number.isInteger(payload.version)) return jsonError(c, 400, "VERSION_REQUIRED", "保存笔记必须携带版本号");
  if (payload.version !== current.version) return c.json({ error: { code: "VERSION_CONFLICT", message: "这篇笔记已在别处更新", current: toFullNote(current) } }, 409);

  const title = payload.title === undefined ? current.title : payload.title;
  const contentMarkdown = payload.contentMarkdown === undefined ? current.content_markdown : payload.contentMarkdown;
  const notebookId = payload.notebookId === undefined ? current.notebook_id : payload.notebookId;
  const isFavorite = payload.isFavorite === undefined ? current.is_favorite : payload.isFavorite ? 1 : 0;
  const deletedAt = payload.deleted === undefined ? current.deleted_at : payload.deleted ? now() : null;
  if (!validText(title, 200) || !validText(contentMarkdown, 1_000_000) || typeof notebookId !== "string") return jsonError(c, 413, "NOTE_TOO_LARGE", "笔记标题或正文超出长度限制");
  const notebook = await c.env.DB.prepare("SELECT id FROM notebooks WHERE id = ? AND user_id = ?").bind(notebookId, user.id).first<{ id: string }>();
  if (!notebook) return jsonError(c, 400, "INVALID_NOTEBOOK", "笔记本不存在");
  const updatedAt = now();

  const result = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE notes SET title = ?, content_markdown = ?, notebook_id = ?, is_favorite = ?, deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?").bind(title, contentMarkdown, notebookId, isFavorite, deletedAt, updatedAt, current.id, user.id, current.version),
    c.env.DB.prepare("DELETE FROM notes_fts WHERE note_id = ?").bind(current.id),
    c.env.DB.prepare("INSERT INTO notes_fts (note_id, title, content) VALUES (?, ?, ?)").bind(current.id, title, contentMarkdown),
  ]);
  if (!result[0]?.meta?.changes) {
    const latest = await getNote(c.env, user.id, current.id);
    return c.json({ error: { code: "VERSION_CONFLICT", message: "这篇笔记已在别处更新", current: latest ? toFullNote(latest) : null } }, 409);
  }
  const row = await getNote(c.env, user.id, current.id);
  return c.json({ note: row ? toFullNote(row) : null });
});

api.delete("/api/notes/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const note = await getNote(c.env, user.id, c.req.param("id") ?? "");
  if (!note) return jsonError(c, 404, "NOTE_NOT_FOUND", "笔记不存在");
  if (!note.deleted_at) return jsonError(c, 400, "NOTE_NOT_TRASHED", "只能永久删除回收站中的笔记");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM notes_fts WHERE note_id = ?").bind(note.id),
    c.env.DB.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?").bind(note.id, user.id),
  ]);
  return c.json({ ok: true });
});

api.get("/api/notebooks", requireAuth, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.name, b.color, b.is_system,
      (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = b.id AND n.deleted_at IS NULL) AS count
     FROM notebooks b WHERE b.user_id = ? ORDER BY b.sort_order, b.name`,
  ).bind(c.get("user").id).all<{ id: string; name: string; color: string; is_system: number; count: number }>();
  return c.json({ notebooks: (rows.results ?? []).map((row) => ({ id: row.id, name: row.name, color: row.color, isSystem: Boolean(row.is_system), count: Number(row.count) })) });
});

api.post("/api/notebooks", requireAuth, async (c) => {
  const payload = await readJson<{ name?: unknown; color?: unknown }>(c);
  if (!payload || !validText(payload.name, 40) || !payload.name.trim()) return jsonError(c, 400, "INVALID_NOTEBOOK", "请输入笔记本名称");
  const id = crypto.randomUUID();
  const createdAt = now();
  try {
    await c.env.DB.prepare("INSERT INTO notebooks (id, user_id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 10, ?, ?)").bind(id, c.get("user").id, payload.name.trim(), typeof payload.color === "string" ? payload.color : "#718077", createdAt, createdAt).run();
  } catch {
    return jsonError(c, 409, "NOTEBOOK_EXISTS", "已经有同名笔记本");
  }
  return c.json({ notebook: { id, name: payload.name.trim(), color: typeof payload.color === "string" ? payload.color : "#718077", isSystem: false, count: 0 } }, 201);
});

api.patch("/api/notebooks/:id", requireAuth, async (c) => {
  const current = await c.env.DB.prepare("SELECT id, name, color, is_system FROM notebooks WHERE id = ? AND user_id = ?").bind(c.req.param("id") ?? "", c.get("user").id).first<{ id: string; name: string; color: string; is_system: number }>();
  if (!current) return jsonError(c, 404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
  const payload = await readJson<{ name?: unknown; color?: unknown }>(c);
  const name = payload?.name === undefined ? current.name : payload.name;
  const color = payload?.color === undefined ? current.color : payload.color;
  if (!validText(name, 40) || !name.trim() || typeof color !== "string") return jsonError(c, 400, "INVALID_NOTEBOOK", "笔记本名称无效");
  try {
    await c.env.DB.prepare("UPDATE notebooks SET name = ?, color = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(name.trim(), color, now(), current.id, c.get("user").id).run();
  } catch {
    return jsonError(c, 409, "NOTEBOOK_EXISTS", "已经有同名笔记本");
  }
  return c.json({ notebook: { id: current.id, name: name.trim(), color, isSystem: Boolean(current.is_system) } });
});

api.delete("/api/notebooks/:id", requireAuth, async (c) => {
  const userId = c.get("user").id;
  const current = await c.env.DB.prepare("SELECT id, is_system FROM notebooks WHERE id = ? AND user_id = ?").bind(c.req.param("id") ?? "", userId).first<{ id: string; is_system: number }>();
  if (!current) return jsonError(c, 404, "NOTEBOOK_NOT_FOUND", "笔记本不存在");
  if (current.is_system) return jsonError(c, 400, "SYSTEM_NOTEBOOK", "收件箱不能删除");
  const inbox = await c.env.DB.prepare("SELECT id FROM notebooks WHERE user_id = ? AND is_system = 1 LIMIT 1").bind(userId).first<{ id: string }>();
  if (!inbox) return jsonError(c, 500, "NO_INBOX", "找不到收件箱");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE notes SET notebook_id = ?, updated_at = ? WHERE notebook_id = ? AND user_id = ?").bind(inbox.id, now(), current.id, userId),
    c.env.DB.prepare("DELETE FROM notebooks WHERE id = ? AND user_id = ?").bind(current.id, userId),
  ]);
  return c.json({ ok: true });
});

api.post("/api/notes/:id/shares", requireAuth, async (c) => {
  const user = c.get("user");
  const note = await getNote(c.env, user.id, c.req.param("id") ?? "");
  if (!note || note.deleted_at) return jsonError(c, 404, "NOTE_NOT_FOUND", "笔记不存在");
  const createdAt = now();
  const expiresAt = createdAt + SHARE_TTL;
  const shareId = crypto.randomUUID();
  const token = createOpaqueToken();
  await c.env.DB.prepare("INSERT INTO shares (id, note_id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(shareId, note.id, user.id, await digestHex(token), createdAt, expiresAt).run();
  const snapshot: ShareSnapshot = { schemaVersion: 1, title: note.title, contentMarkdown: note.content_markdown, createdAt, expiresAt };
  try {
    await c.env.SHARE_KV.put(`share:${token}`, JSON.stringify(snapshot), { expirationTtl: SHARE_TTL });
  } catch {
    await c.env.DB.prepare("UPDATE shares SET revoked_at = ? WHERE id = ?").bind(now(), shareId).run();
    return jsonError(c, 500, "SHARE_STORAGE_FAILED", "分享快照写入失败，请稍后重试");
  }
  return c.json({ share: { id: shareId, noteId: note.id, expiresAt, revokedAt: null, createdAt, url: `${new URL(c.req.url).origin}/share/${token}` } }, 201);
});

api.get("/api/notes/:id/shares", requireAuth, async (c) => {
  const note = await getNote(c.env, c.get("user").id, c.req.param("id") ?? "");
  if (!note) return jsonError(c, 404, "NOTE_NOT_FOUND", "笔记不存在");
  const rows = await c.env.DB.prepare("SELECT id, note_id, created_at, expires_at, revoked_at FROM shares WHERE note_id = ? AND user_id = ? ORDER BY created_at DESC").bind(note.id, c.get("user").id).all<{ id: string; note_id: string; created_at: number; expires_at: number; revoked_at: number | null }>();
  return c.json({ shares: (rows.results ?? []).map((row) => ({ id: row.id, noteId: row.note_id, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at })) });
});

api.delete("/api/shares/:id", requireAuth, async (c) => {
  const result = await c.env.DB.prepare("UPDATE shares SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(now(), c.req.param("id") ?? "", c.get("user").id).run();
  if (!result.meta.changes) return jsonError(c, 404, "SHARE_NOT_FOUND", "分享链接不存在");
  return c.json({ ok: true });
});

api.get("/api/shares/:token", async (c) => {
  const token = c.req.param("token");
  const row = await c.env.DB.prepare("SELECT id, expires_at, revoked_at FROM shares WHERE token_hash = ?").bind(await digestHex(token)).first<{ id: string; expires_at: number; revoked_at: number | null }>();
  if (!row) return jsonError(c, 404, "SHARE_NOT_FOUND", "分享链接不存在");
  if (row.revoked_at) return jsonError(c, 410, "SHARE_REVOKED", "分享链接已撤销");
  if (row.expires_at <= now()) return jsonError(c, 410, "SHARE_EXPIRED", "分享链接已过期");
  const value = await c.env.SHARE_KV.get(`share:${token}`, "json");
  if (!value) return jsonError(c, 410, "SHARE_EXPIRED", "分享链接已过期");
  return c.json({ snapshot: value as ShareSnapshot });
});

api.notFound((c) => c.req.path.startsWith("/api/") ? jsonError(c, 404, "NOT_FOUND", "接口不存在") : c.text("Not found", 404));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api.fetch(request as any, env, ctx as any);
    return env.ASSETS.fetch(request as any);
  },
};

export { buildFtsQuery, constantTimeEqual, createOpaqueToken, derivePassword, formatPreview, hashPassword };
