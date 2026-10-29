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

  const versions = ids.map((id) => ({ id, version: getVersion(id) }));
  const missingVersion = versions.find(({ version }) => version === undefined);
  if (missingVersion) {
    refresh();
    return {
      error: new Error(`无法获取笔记 ${missingVersion.id} 的最新版本，请刷新后重试`),
      failed: true,
    };
  }

  const moves = await Promise.allSettled(versions.map(({ id, version }) => moveNote(id, version!)));
  refresh();
  const moveFailure = moves.find((result) => result.status === "rejected");
  return moveFailure?.status === "rejected" ? { error: moveFailure.reason, failed: true } : {};
}
