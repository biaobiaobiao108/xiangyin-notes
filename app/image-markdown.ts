export const LOCAL_IMAGE_SCHEME = "offline-image://";

export type ParsedImageSource = {
  src: string;
  width: number | null;
  height: number | null;
};

function positiveInteger(value: string | null) {
  if (!value || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseImageSource(source: string): ParsedImageSource {
  const hashIndex = source.indexOf("#");
  const hash = hashIndex >= 0 ? source.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
  const queryIndex = withoutHash.indexOf("?");
  if (queryIndex < 0) return { src: source, width: null, height: null };
  const base = withoutHash.slice(0, queryIndex);
  const params = new URLSearchParams(withoutHash.slice(queryIndex + 1));
  const width = positiveInteger(params.get("w"));
  const height = positiveInteger(params.get("h"));
  params.delete("w");
  params.delete("h");
  const query = params.toString();
  return { src: `${base}${query ? `?${query}` : ""}${hash}`, width, height };
}

export function serializeImageSource(source: string, width: number | null | undefined, height: number | null | undefined) {
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

export function isLocalImageSource(source: string) {
  return source.startsWith(LOCAL_IMAGE_SCHEME);
}

export function localImageId(source: string) {
  return isLocalImageSource(source) ? parseImageSource(source).src.slice(LOCAL_IMAGE_SCHEME.length) : null;
}

export function replaceLocalImageReferences(markdown: string, replacements: ReadonlyMap<string, string>) {
  if (!replacements.size) return markdown;
  return markdown.replace(/offline-image:\/\/([0-9a-f-]{36})/giu, (match, id: string) => replacements.get(id.toLowerCase()) ?? match);
}

export function firstImageSource(markdown: string) {
  const match = markdown.match(/!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/u);
  return match?.[1] ?? null;
}

export function escapeImageAlt(value: string) {
  return value.replace(/[\\\]]/gu, "\\$&").replace(/\r?\n/gu, " ");
}
