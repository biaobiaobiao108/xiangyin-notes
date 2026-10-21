import { Extension, type Editor, type JSONContent } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

type UploadToken = object;
type UploadPositionAction = { token: UploadToken; position: number } | { token: UploadToken };
const uploadPositionsKey = new PluginKey<ReadonlyMap<UploadToken, number>>("imageUploadPositions");

export function createImageUploadPositionPlugin() {
  return new Plugin({
    key: uploadPositionsKey,
    state: {
      init: () => new Map<UploadToken, number>(),
      apply(transaction, previous: ReadonlyMap<UploadToken, number>) {
        const action = transaction.getMeta(uploadPositionsKey) as UploadPositionAction | undefined;
        if (!action && (!transaction.docChanged || previous.size === 0)) return previous;
        const positions = new Map<UploadToken, number>();
        for (const [token, position] of previous) {
          const mapped = transaction.mapping.mapResult(position, 1);
          if (!mapped.deleted) positions.set(token, mapped.pos);
        }
        if (action) {
          if ("position" in action) positions.set(action.token, action.position);
          else positions.delete(action.token);
        }
        return positions;
      },
    },
  });
}

export const ImageUploadPositions = Extension.create({
  name: "imageUploadPositions",
  addProseMirrorPlugins: () => [createImageUploadPositionPlugin()],
});

/** Track a collapsed insertion point without retaining or replacing a selection. */
export function createImageUploadPosition(editor: Editor) {
  const token: UploadToken = {};
  editor.view.dispatch(editor.state.tr.setMeta(uploadPositionsKey, { token, position: editor.state.selection.from }));
  return {
    insert(content: JSONContent) {
      if (editor.isDestroyed) return false;
      const position = uploadPositionsKey.getState(editor.state)?.get(token);
      if (position === undefined) return false;
      return editor.chain()
        .insertContentAt(position, content, { updateSelection: false })
        .command(({ tr }) => {
          // Inserting a block may replace an empty paragraph containing the
          // anchor. Keep this upload's next image after the inserted block.
          tr.setMeta(uploadPositionsKey, { token, position: tr.mapping.map(position, 1) });
          return true;
        }).run();
    },
    dispose() {
      if (editor.isDestroyed || !uploadPositionsKey.getState(editor.state)?.has(token)) return;
      editor.view.dispatch(editor.state.tr.setMeta(uploadPositionsKey, { token }));
    },
  };
}
