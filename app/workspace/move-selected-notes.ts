type MoveSelectedNotesOptions = {
  flushEditorDraft: () => void;
  saveNote: (id: string) => Promise<unknown>;
  getVersion: (id: string) => number | undefined;
  moveNote: (id: string, version: number) => Promise<unknown>;
  refresh: () => void;
};

export async function moveSelectedNotes(
  ids: string[],
  { flushEditorDraft, saveNote, getVersion, moveNote, refresh }: MoveSelectedNotesOptions,
): Promise<{ error?: unknown; failed?: true }> {
  if (!ids.length) return {};

  flushEditorDraft();
  const saves = await Promise.allSettled(ids.map((id) => saveNote(id)));
  const saveFailure = saves.find((result) => result.status === "rejected");
  if (saveFailure?.status === "rejected") {
    refresh();
    return { error: saveFailure.reason, failed: true };
  }

  const moves = await Promise.allSettled(
    ids.flatMap((id) => {
      const version = getVersion(id);
      return version === undefined ? [] : [moveNote(id, version)];
    }),
  );
  refresh();
  const moveFailure = moves.find((result) => result.status === "rejected");
  return moveFailure?.status === "rejected" ? { error: moveFailure.reason, failed: true } : {};
}
