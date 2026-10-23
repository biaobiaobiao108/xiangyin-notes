import { json, jsonError, type RouteContext } from "../core";
import { requireApiToken } from "../api-token";
import { ensureEnvironmentUser, getAuthCredentials } from "./auth";
import { handleNotesRoute } from "./notes";
import type { Note, NoteSummary } from "../../shared/types";

type NotesListResponse = {
  notes: NoteSummary[];
  total?: number;
  hasMore?: boolean;
  nextCursor?: string;
};

function toApiNoteSummary(note: NoteSummary) {
  return {
    id: note.id,
    title: note.title,
    preview: note.preview,
    tags: note.tags,
    notebookId: note.notebookId,
    notebookName: note.notebookName,
    isFavorite: note.isFavorite,
    deletedAt: note.deletedAt,
    version: note.version,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function toApiNote(note: Note) {
  return { ...toApiNoteSummary(note), contentMarkdown: note.contentMarkdown };
}

export async function handleVersionedApiRoute(
  ctx: RouteContext,
  assetRoot: string,
): Promise<Response> {
  const { request, url, method, segments, options } = ctx;
  if (segments[1] !== "notes" || (segments.length !== 2 && segments.length !== 3))
    return jsonError(404, "NOT_FOUND", "接口不存在");

  const tokenError = requireApiToken(request, options.environment ?? {});
  if (tokenError) return tokenError;
  if (method !== "GET")
    return jsonError(405, "METHOD_NOT_ALLOWED", "只读接口只支持 GET", { Allow: "GET" });

  const credentials = getAuthCredentials(options.environment);
  if (!credentials)
    return jsonError(
      503,
      "AUTH_NOT_CONFIGURED",
      "请先配置 XIANGYING_USERNAME 和 XIANGYING_PASSWORD",
    );

  const user = await ensureEnvironmentUser(options.database, credentials, options.realtime);
  const notePath = segments.slice(1).map(encodeURIComponent).join("/");
  const internalUrl = new URL(url);
  internalUrl.pathname = `/api/${notePath}`;
  if (segments.length === 3) internalUrl.searchParams.delete("response");
  const internalRequest = new Request(internalUrl, request);
  const internalContext: RouteContext = {
    ...ctx,
    request: internalRequest,
    url: internalUrl,
    segments: segments.slice(1),
  };
  const internalResponse = await handleNotesRoute(internalContext, user, assetRoot);
  if (!internalResponse) return jsonError(404, "NOT_FOUND", "接口不存在");
  if (!internalResponse.ok) return internalResponse;

  if (segments.length === 2) {
    const page = (await internalResponse.json()) as NotesListResponse;
    return json({
      notes: page.notes.map(toApiNoteSummary),
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.hasMore === undefined ? {} : { hasMore: page.hasMore }),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  }

  const detail = (await internalResponse.json()) as { note: Note };
  return json({ note: toApiNote(detail.note) });
}
