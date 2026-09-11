import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export const LEAKED_IME_PREFIX_RE = /^([a-z])(\p{Script=Han})/u;

export function healLeakedImePrefix(text: string): { healed: string; leaked: string } | null {
  const match = LEAKED_IME_PREFIX_RE.exec(text);
  if (!match) return null;
  return {
    leaked: match[1],
    healed: text.slice(match[1].length),
  };
}

export interface ImeSafeState {
  trackedBlockPos: number | null;
  isComposing: boolean;
}

export const imeMarkdownSafePluginKey = new PluginKey<ImeSafeState>("imeMarkdownSafe");

export const ImeMarkdownSafeExtension = Extension.create({
  name: "imeMarkdownSafe",

  addProseMirrorPlugins() {
    return [
      new Plugin<ImeSafeState>({
        key: imeMarkdownSafePluginKey,
        state: {
          init() {
            return { trackedBlockPos: null, isComposing: false };
          },
          apply(tr, prev) {
            let { trackedBlockPos, isComposing } = prev;
            const meta = tr.getMeta(imeMarkdownSafePluginKey) as { type: string; pos?: number } | undefined;
            if (meta) {
              if (meta.type === "blockConverted") {
                trackedBlockPos = meta.pos ?? null;
              } else if (meta.type === "compositionStart") {
                isComposing = true;
                if (meta.pos !== undefined) trackedBlockPos = meta.pos;
              } else if (meta.type === "compositionEnd") {
                isComposing = false;
              } else if (meta.type === "healed" || meta.type === "clear") {
                trackedBlockPos = null;
              }
            }

            if (trackedBlockPos !== null && tr.docChanged) {
              trackedBlockPos = tr.mapping.map(trackedBlockPos);
            }

            return { trackedBlockPos, isComposing };
          },
        },
        appendTransaction(transactions, _oldState, newState) {
          if (transactions.some((tr) => (tr.getMeta(imeMarkdownSafePluginKey) as { type?: string } | undefined)?.type === "healed")) {
            return null;
          }

          const pluginState = imeMarkdownSafePluginKey.getState(newState);
          if (!pluginState || pluginState.trackedBlockPos === null) {
            return null;
          }

          const docSize = newState.doc.content.size;
          const targetPos = Math.min(pluginState.trackedBlockPos, docSize);
          const $pos = newState.doc.resolve(targetPos);
          const block = $pos.parent;
          const blockText = block.textContent;

          const healedResult = healLeakedImePrefix(blockText);
          if (healedResult) {
            const startOfBlock = $pos.start();
            const tr = newState.tr.delete(startOfBlock, startOfBlock + healedResult.leaked.length);
            tr.setMeta(imeMarkdownSafePluginKey, { type: "healed" });
            return tr;
          }

          if (blockText.length > 1 && !/^[a-z]$/.test(blockText)) {
            const tr = newState.tr;
            tr.setMeta(imeMarkdownSafePluginKey, { type: "clear" });
            return tr;
          }

          return null;
        },
        props: {
          handleDOMEvents: {
            compositionstart(view) {
              const { $from } = view.state.selection;
              const blockStart = $from.start();
              const isTargetBlock = $from.parent.content.size === 0 || ($from.parentOffset === 0 && $from.parent.textContent.length <= 1);
              const tr = view.state.tr.setMeta(imeMarkdownSafePluginKey, {
                type: "compositionStart",
                pos: isTargetBlock ? blockStart : undefined,
              });
              view.dispatch(tr);
              return false;
            },
            compositionend(view) {
              const tr = view.state.tr.setMeta(imeMarkdownSafePluginKey, { type: "compositionEnd" });
              view.dispatch(tr);

              setTimeout(() => {
                if (!view || view.isDestroyed) return;
                const { state, dispatch } = view;
                const { $from } = state.selection;
                const block = $from.parent;
                const healedResult = healLeakedImePrefix(block.textContent);
                if (healedResult) {
                  const startOfBlock = $from.start();
                  dispatch(state.tr.delete(startOfBlock, startOfBlock + healedResult.leaked.length).scrollIntoView());
                }
              }, 20);
              return false;
            },
          },
        },
      }),
    ];
  },
});
