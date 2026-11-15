export function stickyGroupOffset(
  nextGroupTop: number | undefined,
  viewportTop: number,
  headerHeight: number,
) {
  if (nextGroupTop === undefined) return 0;
  return Math.min(0, Math.max(-headerHeight, nextGroupTop - viewportTop - headerHeight));
}
