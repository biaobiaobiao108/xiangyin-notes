type MoveSelectedNotesOptions = {
  flushEditorDraft: () => void;
  saveNote: (id: string) => Promise<unknown>;
  moveNote: (id: string) => Promise<boolean>;
};

export async function moveSelectedNotes(
  ids: string[],
  { flushEditorDraft, saveNote, moveNote }: MoveSelectedNotesOptions,
): Promise<{ movedIds: string[]; failures: unknown[] }> {
  if (!ids.length) return { movedIds: [], failures: [] };

  flushEditorDraft();
  const saves = await Promise.allSettled(ids.map(saveNote));
  const saveFailures = saves.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (saveFailures.length) return { movedIds: [], failures: saveFailures };

  const moves = await Promise.allSettled(ids.map(moveNote));
  return {
    movedIds: ids.filter((_, index) => moves[index]?.status === "fulfilled" && moves[index].value),
    failures: moves.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  };
}
