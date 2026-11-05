/** Preserve source offsets while hiding annotation metadata from body scanners. */
export function maskHtmlAttributeValues(markdown: string) {
  if (!markdown.includes("data-") && !markdown.includes("aria-")) return markdown;
  return markdown.replace(/\b(?:data-[\w-]+|aria-[\w-]+)="[^"]*"/g, (match) => {
    const valueStart = match.indexOf('="') + 2;
    return `${match.slice(0, valueStart)}${" ".repeat(match.length - valueStart - 1)}"`;
  });
}
