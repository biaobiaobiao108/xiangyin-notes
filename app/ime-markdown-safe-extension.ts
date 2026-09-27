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
  committedText: string | null;
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
            return { trackedBlockPos: null, isComposing: false, committedText: null };
          },
          apply(tr, prev) {
            let { trackedBlockPos, isComposing, committedText } = prev;
            const meta = tr.getMeta(imeMarkdownSafePluginKey) as { type: string; pos?: number; text?: string } | undefined;
            if (meta) {
              if (meta.type === "blockConverted") {
                trackedBlockPos = meta.pos ?? null;
              } else if (meta.type === "compositionStart") {
                isComposing = true;
                trackedBlockPos = meta.pos ?? null;
                committedText = null;
              } else if (meta.type === "compositionEnd") {
                isComposing = false;
                committedText = meta.text || null;
              } else if (meta.type === "compositionCancel") {
                isComposing = false;
                trackedBlockPos = null;
                committedText = null;
              } else if (meta.type === "healed" || meta.type === "clear") {
                trackedBlockPos = null;
              }
            }

            if (trackedBlockPos !== null && tr.docChanged) {
              trackedBlockPos = tr.mapping.map(trackedBlockPos);
            }

            return { trackedBlockPos, isComposing, committedText };
          },
        },
        appendTransaction(transactions, _oldState, newState) {
          if (transactions.some((tr) => (tr.getMeta(imeMarkdownSafePluginKey) as { type?: string } | undefined)?.type === "healed")) {
            return null;
          }

          const pluginState = imeMarkdownSafePluginKey.getState(newState);
          if (!pluginState || pluginState.trackedBlockPos === null || pluginState.isComposing) {
            return null;
          }

          const docSize = newState.doc.content.size;
          const targetPos = Math.min(pluginState.trackedBlockPos, docSize);
          const $pos = newState.doc.resolve(targetPos);
          const block = $pos.parent;
          const blockText = block.textContent;

          const healedResult = healLeakedImePrefix(blockText);
          if (healedResult && (!pluginState.committedText || healedResult.healed.startsWith(pluginState.committedText))) {
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
              // An existing Latin letter is user content, not evidence of an IME leak.
              const isTargetBlock = $from.parent.content.size === 0;
              const tr = view.state.tr.setMeta(imeMarkdownSafePluginKey, {
                type: "compositionStart",
                pos: isTargetBlock ? blockStart : undefined,
              });
              view.dispatch(tr);
              return false;
            },
            compositionend(view, event) {
              const tr = view.state.tr.setMeta(imeMarkdownSafePluginKey, { type: "compositionEnd", text: (event as CompositionEvent).data });
              view.dispatch(tr);
              return false;
            },
            compositioncancel(view) {
              view.dispatch(view.state.tr.setMeta(imeMarkdownSafePluginKey, { type: "compositionCancel" }));
              return false;
            },
          },
        },
      }),
    ];
  },
});
