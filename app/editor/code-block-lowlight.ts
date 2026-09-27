import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";

const commonLowlight = createLowlight(common);
const registeredLanguages = commonLowlight.listLanguages();
const plainTextResult = (code: string) => commonLowlight.highlight("plaintext", code);
const noteLowlight = {
  listLanguages: () => registeredLanguages,
  registered: (language: string) => commonLowlight.registered(language),
  highlight: (language: string, code: string) => registeredLanguages.includes(language) || commonLowlight.registered(language)
    ? commonLowlight.highlight(language, code)
    : plainTextResult(code),
  highlightAuto: (code: string) => plainTextResult(code),
};

export function createCodeBlockLowlightExtension() {
  return CodeBlockLowlight.configure({
    lowlight: noteLowlight,
    exitOnTripleEnter: false,
    defaultLanguage: "plaintext",
  });
}
