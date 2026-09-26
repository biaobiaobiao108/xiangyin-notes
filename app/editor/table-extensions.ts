import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";

/**
 * The editor and read-only renderer share the same GFM table schema. Keeping
 * each cell to one paragraph lets Markdown represent every supported cell.
 */
export function createTableExtensions() {
  return [
    Table.configure({ resizable: false, renderWrapper: true, cellMinWidth: 128 }),
    TableRow,
    TableCell.extend({ content: "paragraph" }),
    TableHeader.extend({ content: "paragraph" }),
  ];
}
