// One MCP connection per signed-in browser session — the MCP server hides write tools by
// realm role, so tools, resources and the system prompt resolve per identity, not once at start-up.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Request } from 'express';
import { validToken } from './auth.js';
import { config } from './config.js';
import { buildSystemPrompt, connectMcp, listResourceDefs, listToolDefs, type ResourceDef } from './mcp.js';
import type { McpToolDef } from '../shared/types.js';

export interface McpSession {
  client: Client;
  toolDefs: McpToolDef[];
  resourceDefs: ResourceDef[];
  systemPrompt: string;
  token?: string;
  touched: number;
}

const IDLE_MS = 30 * 60 * 1000;

const sessions = new Map<string, McpSession>();

async function open(token?: string): Promise<McpSession> {
  const client = await connectMcp(config.mcpUrl, token);
  const [toolDefs, resourceDefs, systemPrompt] = await Promise.all([
    listToolDefs(client),
    listResourceDefs(client),
    buildSystemPrompt(client),
  ]);
  return { client, toolDefs, resourceDefs, systemPrompt, token, touched: Date.now() };
}

export function closeSession(sessionId: string): void {
  const existing = sessions.get(sessionId);
  if (!existing) return;
  sessions.delete(sessionId);
  void existing.client.close().catch(() => undefined);
}

function evictIdle(): void {
  const cutoff = Date.now() - IDLE_MS;
  for (const [id, session] of sessions) {
    if (session.touched < cutoff) closeSession(id);
  }
}

export async function getSession(req: Request): Promise<McpSession> {
  evictIdle();
  const token = config.authEnabled ? await validToken(req) : undefined;
  if (config.authEnabled && !token) {
    throw new Error('not signed in');
  }
  const id = req.sessionID;
  const existing = sessions.get(id);
  // A refreshed token needs a fresh transport, so reconnect when it has changed.
  if (existing && existing.token === token) {
    existing.touched = Date.now();
    return existing;
  }
  if (existing) closeSession(id);
  const session = await open(token);
  sessions.set(id, session);
  return session;
}
