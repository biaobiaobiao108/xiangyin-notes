import type { Editor } from "@tiptap/core";
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

const languageLabels: Record<string, string> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  css: "CSS",
  diff: "Diff",
  go: "Go",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  markdown: "Markdown",
  python: "Python",
  rust: "Rust",
  sql: "SQL",
  shell: "Shell",
  ts: "TypeScript",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
};

export const codeBlockLanguageOptions = [
  { value: "plaintext", label: "纯文本" },
  ...registeredLanguages
    .filter((language) => language !== "plaintext")
    .slice()
    .sort()
    .map((language) => ({
      value: language,
      label: languageLabels[language] ?? language.charAt(0).toLocaleUpperCase() + language.slice(1),
    })),
];

export function setCodeBlockLanguage(editor: Editor, language: string) {
  if (!editor.isActive("codeBlock")) return false;
  if (language !== "plaintext" && !commonLowlight.registered(language)) return false;
  return editor.commands.updateAttributes("codeBlock", { language });
}

export function createCodeBlockLowlightExtension() {
  return CodeBlockLowlight.configure({
    lowlight: noteLowlight,
    exitOnTripleEnter: false,
    defaultLanguage: "plaintext",
  });
}
