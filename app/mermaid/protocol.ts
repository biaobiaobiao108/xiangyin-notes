export const MERMAID_EXAMPLE = "flowchart TD\n  A[开始] --> B[完成]";
export const MERMAID_SOURCE_LIMIT = 50_000;

export function isMermaidLanguage(language: unknown): boolean {
  return typeof language === "string" && /^mermaid(?:\s|$)/iu.test(language.trimStart());
}

export function mermaidTokenSource(text: string, raw: string): string {
  // Marked compensates for indentation on backtick fences, but leaves it on tilde fences.
  const indent = /^( {1,3})~{3}/u.exec(raw)?.[1]?.length;
  return indent ? text.replace(new RegExp(`^ {1,${indent}}`, "gmu"), "") : text;
}

export type DiagramLayout = {
  width: number;
  fontFamily: string;
  fontFamilyMono: string;
};

export type DiagramResult = { svg: string; width: number; height: number };
