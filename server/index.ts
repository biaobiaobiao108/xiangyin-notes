import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  jsonError,
  type RouteContext,
  type ServerOptions,
} from "./core";
import { openDatabase } from "./db";
import { assetRootFromEnv, cleanupOrphanAssets, handleAssetsRoute } from "./routes/assets";
import { cleanupExpiredSessions, handleAuthRoute, isResponse, requireUser } from "./routes/auth";
import { handleExportRoute } from "./routes/export";
import { handleImportRoute } from "./routes/import";
import { handleNotebooksRoute } from "./routes/notebooks";
import { handleNotesRoute } from "./routes/notes";
import { handlePublicShare, handleSharesRoute, servePublicShareAsset } from "./routes/shares";

// Re-exports for backward compatibility and test runners
export {
  buildFtsQuery,
  constantTimeEqual,
  createOpaqueToken,
  derivePassword,
  formatPreview,
  hashPassword,
  parseSearchTerms,
  type ServerOptions,
} from "./core";

const DEFAULT_CLIENT_ROOT = "./dist/client";

const DEV_SERVICE_WORKER_SOURCE = `
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("xiangying-notes-")).map((key) => caches.delete(key)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: "window" });
    await Promise.all(clients.map((client) => client.navigate(client.url)));
  })());
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request));
});
`;

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: blob: https:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};

function withSecurityHeaders(response: Response, environment: Record<string, string | undefined> = {}) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (environment.COOKIE_SECURE === "true") headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

async function serveStatic(request: Request, clientRoot: string, environment: Record<string, string | undefined> = {}) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (pathname.includes("\0") || pathname.split(/[\\/]/).includes("..")) return new Response("Forbidden", { status: 403 });

  if (pathname === "/sw.js" && environment.NODE_ENV === "development") {
    return new Response(request.method === "HEAD" ? null : DEV_SERVICE_WORKER_SOURCE, {
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "text/javascript; charset=utf-8",
      },
    });
  }

  const relativePath = pathname.replace(/^[/\\]+/, "");
  const hasExtension = extname(relativePath) !== "";
  const rootPath = resolve(clientRoot);
  const requestedPath = hasExtension ? resolve(rootPath, relativePath) : join(rootPath, "index.html");
  const pathFromRoot = relative(rootPath, requestedPath);
  if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot.startsWith(sep)) return new Response("Forbidden", { status: 403 });
  const file = Bun.file(requestedPath);
  if (!(await file.exists())) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  headers.set("Content-Type", MIME_TYPES[extname(requestedPath).toLowerCase()] ?? file.type ?? "application/octet-stream");
  const basename = relativePath.toLowerCase();
  const mutablePwaAsset = basename === "sw.js" || basename === "manifest.webmanifest";
  headers.set("Cache-Control", hasExtension && relativePath !== "index.html" && !mutablePwaAsset ? "public, max-age=31536000, immutable" : "no-cache");
  return new Response(request.method === "HEAD" ? null : file, { headers });
}

async function handleApi(request: Request, options: ServerOptions) {
  const { database, environment = {} } = options;
  const assetRoot = resolve(options.assetRoot ?? assetRootFromEnv(environment));
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).slice(1).map((segment) => decodeURIComponent(segment));
  } catch {
    return jsonError(400, "INVALID_PATH", "请求路径无效");
  }

  cleanupExpiredSessions(database);
  void cleanupOrphanAssets(database, assetRoot).catch((error) => console.warn("[assets] orphan cleanup failed", error));

  const ctx: RouteContext = { request, url, method, segments, options };

  // 1. Unauthenticated routes (Health, Auth, Bootstrap, Setup, Public Shares)
  const authResponse = await handleAuthRoute(ctx);
  if (authResponse) return authResponse;

  const publicShareResponse = await handleSharesRoute(ctx, null);
  if (publicShareResponse) return publicShareResponse;

  const importResponse = await handleImportRoute(ctx);
  if (importResponse) return importResponse;

  // 2. Authenticated barrier
  const user = await requireUser(database, environment, request);
  if (isResponse(user)) return user;

  // 3. Domain routes
  const notesResponse = await handleNotesRoute(ctx, user, assetRoot);
  if (notesResponse) return notesResponse;

  const notebooksResponse = await handleNotebooksRoute(ctx, user);
  if (notebooksResponse) return notebooksResponse;

  const sharesResponse = await handleSharesRoute(ctx, user);
  if (sharesResponse) return sharesResponse;

  const assetsResponse = await handleAssetsRoute(ctx, user, assetRoot);
  if (assetsResponse) return assetsResponse;

  const exportResponse = await handleExportRoute(ctx, user, assetRoot);
  if (exportResponse) return exportResponse;

  return jsonError(404, "NOT_FOUND", "接口不存在");
}

export async function handleRequest(request: Request, options: ServerOptions) {
  try {
    const url = new URL(request.url);
    const environment = options.environment ?? {};
    let response: Response;
    if (url.pathname === "/api/share-assets/" || url.pathname.startsWith("/api/share-assets/")) {
      response = await servePublicShareAsset(request, options.database, resolve(options.assetRoot ?? assetRootFromEnv(environment)));
    } else if (url.pathname === "/api/shares/" || url.pathname.startsWith("/api/shares/")) {
      const segments = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && segments.length === 3) response = await handlePublicShare(request, options.database);
      else response = url.pathname.startsWith("/api/") ? await handleApi(request, options) : await serveStatic(request, options.clientRoot ?? DEFAULT_CLIENT_ROOT, environment);
    } else if (url.pathname.startsWith("/api/")) {
      response = await handleApi(request, options);
    } else {
      response = await serveStatic(request, options.clientRoot ?? DEFAULT_CLIENT_ROOT, environment);
    }
    return withSecurityHeaders(response, environment);
  } catch (error) {
    const url = new URL(request.url);
    console.error(`[request] ${request.method} ${url.pathname}`, error);
    if (url.pathname.startsWith("/api/")) return withSecurityHeaders(jsonError(500, "INTERNAL_ERROR", "服务器暂时无法处理请求"), options.environment);
    return withSecurityHeaders(new Response("Internal Server Error", { status: 500 }), options.environment);
  }
}

if (import.meta.main) {
  const database = await openDatabase();
  const port = Number.parseInt(Bun.env.PORT ?? "3000", 10) || 3000;
  const hostname = Bun.env.HOST?.trim() || "0.0.0.0";
  const clientRoot = Bun.env.CLIENT_ROOT?.trim() || DEFAULT_CLIENT_ROOT;
  const server = Bun.serve({
    hostname,
    port,
    fetch(request, server) {
      return handleRequest(request, { database, environment: Bun.env, clientRoot, clientAddress: server.requestIP(request)?.address });
    },
    error(error) {
      console.error("[server] uncaught error", error);
      return withSecurityHeaders(jsonError(500, "INTERNAL_ERROR", "服务器暂时无法处理请求"), Bun.env);
    },
  });
  console.log(`象映笔记服务已启动：${server.url}`);

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: string) => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      console.log(`[server] 收到 ${signal}，开始关闭服务`);

      let forceShutdownTimer: ReturnType<typeof setTimeout> | null = null;
      const forceShutdown = new Promise<"forced">((resolveForceShutdown) => {
        forceShutdownTimer = setTimeout(() => {
          console.warn("[server] 优雅关闭超时，强制关闭活动连接");
          void server.stop(true).then(() => resolveForceShutdown("forced"), (error) => {
            console.error("[server] 强制关闭服务失败", error);
            resolveForceShutdown("forced");
          });
        }, 5_000);
      });

      try {
        await Promise.race([server.stop(), forceShutdown]);
      } finally {
        if (forceShutdownTimer) clearTimeout(forceShutdownTimer);
        database.close();
        console.log("[server] 服务已关闭");
      }
    })();

    return shutdownPromise;
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
