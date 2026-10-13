export type ParsedImageSource = {
  src: string;
  width: number | null;
  height: number | null;
};

export function isExternalImageSource(source: string) {
  const normalized = source.trim().replace(/\\/gu, "/");
  return /^(?:https?:\/|\/\/)/iu.test(normalized);
}

function positiveInteger(value: string | null) {
  if (!value || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseImageSource(source: string): ParsedImageSource {
  // Query parameters on remote URLs belong to the image host (and may be
  // signed). The editor's width/height metadata must never rewrite them.
  if (isExternalImageSource(source)) return { src: source, width: null, height: null };

  const hashIndex = source.indexOf("#");
  const hash = hashIndex >= 0 ? source.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
  const queryIndex = withoutHash.indexOf("?");
  if (queryIndex < 0) return { src: source, width: null, height: null };
  const base = withoutHash.slice(0, queryIndex);
  const queryParts = withoutHash.slice(queryIndex + 1).split("&");
  let width: number | null = null;
  let height: number | null = null;

  for (const part of queryParts) {
    const rawKey = part.slice(0, part.indexOf("=") < 0 ? part.length : part.indexOf("="));
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/gu, " "));
    } catch {
      // Keep malformed query segments byte-for-byte.
    }
    const value = new URLSearchParams(part).get(key);
    const dimension = key === "w" ? "width" : key === "h" ? "height" : null;
    const parsed = dimension ? positiveInteger(value) : null;
    if (parsed === null) continue;
    if (dimension === "width" && width === null) width = parsed;
    if (dimension === "height" && height === null) height = parsed;
  }

  // Dimensions are stored as a pair. If only one is present, leave the query
  // untouched since it may be part of the source URL rather than editor data.
  if (width === null || height === null) return { src: source, width: null, height: null };

  const preservedParts = queryParts.filter((part) => {
    const rawKey = part.slice(0, part.indexOf("=") < 0 ? part.length : part.indexOf("="));
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/gu, " "));
    } catch {
      // Keep malformed query segments byte-for-byte.
    }
    const value = new URLSearchParams(part).get(key);
    return !((key === "w" || key === "h") && positiveInteger(value) !== null);
  });
  const query = preservedParts.join("&");
  return { src: `${base}${query ? `?${query}` : ""}${hash}`, width, height };
}

export function serializeImageSource(source: string, width: number | null | undefined, height: number | null | undefined) {
  if (isExternalImageSource(source)) return source;
  const parsed = parseImageSource(source);
  const clean = parsed.src;
  if (!width || !height) return clean;
  const hashIndex = clean.indexOf("#");
  const hash = hashIndex >= 0 ? clean.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? clean.slice(0, hashIndex) : clean;
  const queryIndex = withoutHash.indexOf("?");
  const base = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const params = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "");
  params.set("w", String(Math.max(1, Math.round(width))));
  params.set("h", String(Math.max(1, Math.round(height))));
  return `${base}?${params.toString()}${hash}`;
}

export function escapeImageAlt(value: string) {
  return value.replace(/[\\\]]/gu, "\\$&").replace(/\r?\n/gu, " ");
}
