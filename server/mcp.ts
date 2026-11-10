import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import {
  MCP_SERVER_INSTRUCTIONS,
  mcpUser,
  rawResponseValue,
  type McpToolContext,
} from "./mcp-helpers";
import { registerMcpContentTools } from "./mcp-content-tools";
import { registerMcpNotebookTools } from "./mcp-notebook-tools";
import { registerMcpNoteTools } from "./mcp-note-tools";
import { registerMcpNoteEditTools } from "./mcp-note-edit-tools";
import { registerMcpNoteBatchTools } from "./mcp-note-batch-tools";
import type { ServerOptions } from "./core";

export function createNoteMcpServer(options: ServerOptions, context: McpRequestContext) {
  const server = new McpServer(
    { name: "xiangying-notes", version: "0.1.0" },
    {
      instructions: MCP_SERVER_INSTRUCTIONS,
    },
  );
  const user = mcpUser(context);

  const responseValue: typeof rawResponseValue = (value, isError, resultOptions) => {
    const addLinks = (entry: unknown): unknown => {
      if (Array.isArray(entry)) return entry.map(addLinks);
      if (!entry || typeof entry !== "object") return entry;
      const result = Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [key, addLinks(value)]),
      );
      if (
        typeof result.id === "string" &&
        typeof result.title === "string" &&
        typeof result.version === "number"
      ) {
        const configuredUrl = context.authInfo?.extra?.publicUrl;
        const publicUrl = typeof configuredUrl === "string" ? configuredUrl.trim() : undefined;
        if (publicUrl) {
          try {
            const url = new URL(publicUrl);
            if (url.protocol === "http:" || url.protocol === "https:") {
              url.pathname = "/app";
              url.search = "";
              url.hash = "";
              url.searchParams.set("note", result.id);
              result.webUrl = url.href;
            }
          } catch {
            /* Links are optional when no valid public URL is configured. */
          }
        }
      }
      return result;
    };
    return rawResponseValue(addLinks(value) as Record<string, unknown>, isError, resultOptions);
  };

  const tools: McpToolContext = { options, user, responseValue };
  registerMcpContentTools(server, tools);
  registerMcpNotebookTools(server, tools);
  registerMcpNoteTools(server, tools);
  registerMcpNoteEditTools(server, tools);
  registerMcpNoteBatchTools(server, tools);

  return server;
}
