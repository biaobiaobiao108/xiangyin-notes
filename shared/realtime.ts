export type WorkspaceChangeResource = "notes" | "notebooks" | "shares";

export type WorkspaceChangeMessage = {
  type: "workspace.changed";
  revision: number;
  resource: WorkspaceChangeResource;
  noteId?: string;
};
