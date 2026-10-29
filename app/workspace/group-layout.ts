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

export function noteGroupLayoutOffsets(
  rows: readonly { kind: string; groupId?: string; group?: { id: string } }[],
  offsets: readonly number[],
) {
  const result = [...offsets];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const nextRow = rows[index + 1];
    if (row.kind === "group" && nextRow?.kind === "note" && nextRow.groupId === row.group?.id) {
      result[index + 1] = result[index + 1]! + 4;
    } else if (
      row.kind === "note" &&
      row.groupId &&
      (nextRow?.kind !== "note" || nextRow.groupId !== row.groupId)
    ) {
      result[index + 1] = result[index + 1]! + 4;
    }
  }
  return result;
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
