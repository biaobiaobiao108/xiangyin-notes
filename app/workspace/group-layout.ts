export function stickyGroupOffset(
  nextGroupTop: number | undefined,
  viewportTop: number,
  headerHeight: number,
) {
  if (nextGroupTop === undefined) return 0;
  return Math.min(0, Math.max(-headerHeight, nextGroupTop - viewportTop - headerHeight));
}

export function collapsingGroupRange(
  rows: readonly { kind: string }[],
  offsets: readonly number[],
  start: number | undefined,
) {
  if (start === undefined) return null;
  let end = start + 1;
  while (end < rows.length && rows[end]!.kind !== "group") end += 1;
  return { end, height: offsets[end]! - offsets[start + 1]! };
}

export function partitionVirtualGroupRows<T extends { index: number; top: number }>(
  visibleRows: readonly T[],
  start: number,
  end: number,
  contentTop: number,
  afterTop: number,
) {
  const before: T[] = [];
  const group: Array<T & { localTop: number }> = [];
  const after: Array<T & { localTop: number }> = [];

  for (const item of visibleRows) {
    if (item.index < start) before.push(item);
    else if (item.index > start && item.index < end)
      group.push({ ...item, localTop: item.top - contentTop });
    else if (item.index >= end) after.push({ ...item, localTop: item.top - afterTop });
  }

  return { before, group, after };
}
