export type WorkspaceChangeResource = "notes" | "notebooks";

export type WorkspaceChangeMessage = {
  type: "workspace.changed";
  revision: number;
  resource: WorkspaceChangeResource;
  noteId?: string;
};
