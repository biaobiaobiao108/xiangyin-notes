import { preserveEscapedHashtagsForEditor } from "../../shared/tags";
import { normalizeImagesInEmptyListItems } from "../image-markdown";

export function prepareMarkdownForEditor(markdown: string) {
  return normalizeImagesInEmptyListItems(preserveEscapedHashtagsForEditor(markdown));
}
