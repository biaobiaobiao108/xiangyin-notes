import { extractMarkdownDestinationReferences } from "../shared/markdown-lexer";
import type { ImageAssetSummary } from "../shared/types";
import type { ImageAssetRow, NoteRow, SqliteDatabase } from "./core";

export function assetUrl(id: string) {
  return `/api/assets/${encodeURIComponent(id)}`;
}

export function toImageAsset(
  row: Pick<
    ImageAssetRow,
    "id" | "original_name" | "mime_type" | "byte_size" | "width" | "height" | "created_at"
  >,
): ImageAssetSummary {
  return {
    id: row.id,
    url: assetUrl(row.id),
    originalName: row.original_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    width: Number(row.width),
    height: Number(row.height),
    createdAt: Number(row.created_at),
  };
}

export function thumbnailFromNoteRow(row: NoteRow): ImageAssetSummary | null {
  if (
    !row.thumbnail_asset_id ||
    !row.thumbnail_original_name ||
    !row.thumbnail_mime_type ||
    row.thumbnail_byte_size === null ||
    row.thumbnail_width === null ||
    row.thumbnail_height === null ||
    row.thumbnail_created_at === null
  )
    return null;
  return toImageAsset({
    id: row.thumbnail_asset_id,
    original_name: row.thumbnail_original_name,
    mime_type: row.thumbnail_mime_type,
    byte_size: row.thumbnail_byte_size,
    width: row.thumbnail_width,
    height: row.thumbnail_height,
    created_at: row.thumbnail_created_at,
  });
}

export class InvalidNoteAssetsError extends Error {
  constructor() {
    super("invalid-note-assets");
  }
}

export const ASSET_REFERENCE_PATTERN =
  /^\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=[?#]|$)/iu;
export const PRIVATE_ASSET_SOURCE_PATTERN =
  /^\/api\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=[?#]|$)/iu;

export function rewriteMarkdownAssetDestinations(
  markdown: string,
  replacement: (assetId: string) => string | undefined,
) {
  const candidates = /\\?\/api\\?\/assets\\?\/([0-9a-f-]{36})(?![0-9a-z-])/giu;
  const edits = new Map<string, { start: number; end: number; value: string }>();
  const prefix = crypto.randomUUID().slice(0, 24);
  const markedSource = markdown.replace(candidates, (raw, id: string, start: number) => {
    const value = replacement(id.toLowerCase());
    if (value === undefined) return raw;
    // Keep the Markdown syntax and vary just the UUID so the lexer identifies
    // the exact occurrence used as a destination, even when the same URL is prose.
    const marker = prefix + edits.size.toString(16).padStart(12, "0");
    edits.set(marker, { start, end: start + raw.length, value });
    return raw.slice(0, -36) + marker;
  });
  if (!edits.size) return markdown;

  const destinations = new Set<string>();
  for (const { destination } of extractMarkdownDestinationReferences(markedSource, true)) {
    const id = ASSET_REFERENCE_PATTERN.exec(destination)?.[1]?.toLowerCase();
    if (id && edits.has(id)) destinations.add(id);
  }
  if (!destinations.size) return markdown;

  const parts: string[] = [];
  let offset = 0;
  for (const [marker, { start, end, value }] of edits) {
    if (!destinations.has(marker)) continue;
    parts.push(markdown.slice(offset, start), value);
    offset = end;
  }
  return parts.join("") + markdown.slice(offset);
}

function extractNoteAssetReferences(markdown: string) {
  const imageSources: string[] = [];
  const linkDestinations: string[] = [];
  const assetIds = new Set<string>();
  const imageAssetIds = new Set<string>();

  for (const reference of extractMarkdownDestinationReferences(markdown)) {
    if (reference.type === "image") imageSources.push(reference.destination);
    else linkDestinations.push(reference.destination);
    const id = ASSET_REFERENCE_PATTERN.exec(reference.destination)?.[1]?.toLowerCase();
    if (id) {
      assetIds.add(id);
      if (reference.type === "image") imageAssetIds.add(id);
    }
  }

  return {
    imageSources,
    linkDestinations,
    assetIds: [...assetIds],
    imageAssetIds: [...imageAssetIds],
  };
}

export function noteImageSources(markdown: string) {
  return extractNoteAssetReferences(markdown).imageSources;
}

export function noteAssetIds(markdown: string) {
  return extractNoteAssetReferences(markdown).assetIds;
}

export function validNoteImageSource(source: string) {
  if (PRIVATE_ASSET_SOURCE_PATTERN.test(source)) return true;
  try {
    const url = new URL(source);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export function validNoteLinkDestination(destination: string) {
  const value = destination.trim();
  if (!value || value.startsWith("#") || value.startsWith("//")) return true;
  if (!/^[a-z][a-z0-9+.-]*:/iu.test(value)) return true;
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function validNoteAssetReferences(
  database: SqliteDatabase,
  userId: string,
  noteId: string | null,
  contentMarkdown: string,
) {
  const references = extractNoteAssetReferences(contentMarkdown);
  if (references.imageSources.some((source) => !validNoteImageSource(source))) return false;
  if (references.linkDestinations.some((destination) => !validNoteLinkDestination(destination)))
    return false;
  const ids = references.assetIds;
  if (!ids.length) return true;
  const assets = database
    .query(
      `SELECT id, note_id FROM image_assets WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(userId, ...ids) as Array<Pick<ImageAssetRow, "id" | "note_id">>;
  const assetsById = new Map(assets.map((asset) => [asset.id.toLowerCase(), asset]));
  return (
    assets.length === ids.length &&
    ids.every((id) => {
      const asset = assetsById.get(id);
      return Boolean(asset) && (asset?.note_id === null || asset?.note_id === noteId);
    })
  );
}

export function syncNoteAssetReferences(
  database: SqliteDatabase,
  userId: string,
  noteId: string,
  contentMarkdown: string,
) {
  const references = extractNoteAssetReferences(contentMarkdown);
  const ids = references.assetIds;
  const imageDocumentOrder = new Map(references.imageAssetIds.map((id, index) => [id, index]));
  const currentAssets = database
    .query("SELECT id, document_order FROM image_assets WHERE note_id = ? AND user_id = ?")
    .all(noteId, userId) as Array<{ id: string; document_order: number | null }>;
  if (
    currentAssets.length === ids.length &&
    currentAssets.every(
      (asset) =>
        ids.includes(asset.id.toLowerCase()) &&
        asset.document_order === (imageDocumentOrder.get(asset.id.toLowerCase()) ?? null),
    )
  )
    return true;
  const detachedAssetCondition = ids.length
    ? `id NOT IN (${ids.map(() => "?").join(",")})`
    : "1 = 1";
  database
    .query(
      `
    UPDATE image_assets
    SET note_id = NULL, document_order = NULL, orphaned_at = ?
    WHERE note_id = ?
      AND user_id = ?
      AND ${detachedAssetCondition}
  `,
    )
    .run(Math.floor(Date.now() / 1000), noteId, userId, ...ids);
  const assets = ids.length
    ? (database
        .query(
          `SELECT id, user_id, note_id, storage_path, original_name, mime_type, byte_size, width, height, document_order, created_at FROM image_assets WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(userId, ...ids) as ImageAssetRow[])
    : [];
  const assetsById = new Map(assets.map((asset) => [asset.id.toLowerCase(), asset]));
  if (
    assets.length !== ids.length ||
    ids.some((id) => {
      const asset = assetsById.get(id);
      return !asset || (asset.note_id !== null && asset.note_id !== noteId);
    })
  ) {
    return false;
  }

  database
    .query("UPDATE image_assets SET document_order = NULL WHERE note_id = ? AND user_id = ?")
    .run(noteId, userId);
  for (const id of ids) {
    database
      .query(
        "UPDATE image_assets SET note_id = ?, document_order = ?, orphaned_at = NULL WHERE id = ? AND user_id = ?",
      )
      .run(noteId, imageDocumentOrder.get(id) ?? null, id, userId);
  }
  return true;
}
