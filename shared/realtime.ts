export type WorkspaceChangeResource = "notes" | "notebooks" | "memos";

export type WorkspaceChangeMessage = {
  type: "workspace.changed";
  revision: number;
  resource: WorkspaceChangeResource;
  noteId?: string;
};

export type WorkspaceSyncMessage = {
  type: "workspace.sync";
  revision: number;
};
