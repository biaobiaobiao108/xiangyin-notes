export function collapsedGroupScrollTop({
  closing,
  scrollTop,
  scrollEdge,
  sectionTop,
  headerTop,
}: {
  closing: boolean;
  scrollTop: number;
  scrollEdge: number;
  sectionTop: number;
  headerTop: number;
}) {
  if (!closing || sectionTop >= scrollEdge || headerTop > scrollEdge + 1) return null;
  return Math.max(0, scrollTop + sectionTop - scrollEdge);
}

export function stickyGroupOffset(
  nextGroupTop: number | undefined,
  viewportTop: number,
  headerHeight: number,
) {
  if (nextGroupTop === undefined) return 0;
  return Math.min(0, Math.max(-headerHeight, nextGroupTop - viewportTop - headerHeight));
}
