import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpToolDef } from '../shared/types.js';

export async function connectMcp(url: string, tries = 10): Promise<Client> {
  for (let i = 1; ; i++) {
    try {
      const client = new Client({ name: 'ngsi-ld-chat-bot', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      return client;
    } catch (e) {
      if (i >= tries) throw e;
      console.warn(
        `MCP connect failed (${i}/${tries}); retrying in 3s. If the broker is down, run ./services start`,
      );
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

export async function listToolDefs(client: Client): Promise<McpToolDef[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
  }));
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  try {
    const res = await client.callTool({ name, arguments: args });
    const blocks = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const content = blocks
      .map((b) => (b.type === 'text' ? b.text ?? '' : JSON.stringify(b)))
      .join('\n');
    return { content, isError: Boolean(res.isError) };
  } catch (e) {
    return { content: String(e), isError: true };
  }
}

const PERSONA = [
  'You are an FMIS (Farm Management Information System) chat bot for a smart farm,',
  'backed by an NGSI-LD context broker exposed through MCP tools.',
  '',
  'Voice: give plain, practical farm answers (crops, parcels, soil, animals, devices, weather).',
  'No protocol talk unless asked. If the user asks for NGSI-LD detail (entity IDs, attribute',
  'structure, temporal history), switch registers and provide it.',
  '',
  'Be a farm advisor, not just a data readout. Once you have the facts, reason about them:',
  'connect related entities, spot patterns and anomalies, and offer the likely explanation and a',
  'practical next step a farmer would care about. Ground every claim about this farm in data you',
  'retrieved, keep what the data shows separate from what you are inferring, and say when a',
  'hypothesis needs more data to confirm. You may still call tools to test a theory.',
  '',
  'When a question asks WHY an entity is in some state, or to explain / dig deeper, call',
  'get_entity with neighbourhood=true on that entity BEFORE querying other entity types. It',
  'returns the entity plus, per relationship, the entities it points to and every same-type',
  'entity sharing that relationship value (e.g. the other animals in the same barn). The',
  'explanation is often a relationship on one of those neighbours pointing back (a newborn',
  "whose calvedBy is this animal, say), not an attribute on the entity itself. Do not pick a",
  'neighbourhood call — trimming hides the edges that carry the answer.',
  '',
  'Farm-specific facts — entity IDs, attribute values, counts, current state — must come from a',
  'tool call; never guess them. General agricultural knowledge is different: typical ranges and',
  'values, husbandry norms, what a reading means, how to interpret it. Answer those from what',
  'you know and label them as general guidance rather than this farm\'s data. Being a farm',
  'advisor includes knowing the norms, not only reading the sensors. Only decline if the',
  'question is genuinely outside farming.',
  '',
  'You are an autonomous agent. Keep calling tools until you can answer the question. Never end',
  'a turn by only describing the next step — make that tool call in the same turn. If a tool call',
  'fails or returns nothing, recover: call list_entity_types for the real type names and',
  'list_attributes for the real attribute names, or broaden the query, before concluding that',
  'data is absent. Only give a final answer once you have one or have exhausted the tools.',
  '',
  'list_entity_types / get_entity_type / list_attributes report only what is populated on',
  'entities now, so they can be incomplete. Before concluding that a relationship (parentage,',
  'lineage, membership) or an attribute is not tracked at all, check the data model — the',
  'broker may simply hold no value for something the model defines.',
].join('\n');

export interface ResourceDef {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export async function listResourceDefs(client: Client): Promise<ResourceDef[]> {
  try {
    const { resources } = await client.listResources();
    return resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  } catch {
    return [];
  }
}

export async function readResourceText(client: Client, uri: string): Promise<string> {
  const res = await client.readResource({ uri });
  return ((res.contents ?? []) as Array<{ text?: unknown }>)
    .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n');
}

async function readOntology(client: Client, uri: string): Promise<{ uri: string; text: string }> {
  return { uri, text: await readResourceText(client, uri) };
}

/**
 * Locate the data model for an entity type among the MCP server's `ontology://` resources.
 * Mirrors the .claude PreToolUse hook: find the domain, then read `ontology://<domain>/<type>`.
 */
export async function findOntology(
  client: Client,
  type: string,
): Promise<{ uri: string; text: string } | null> {
  const wanted = type.toLowerCase();
  try {
    const { resources } = await client.listResources();

    const exact = resources.find(
      (r) => r.uri.startsWith('ontology://') && r.uri.toLowerCase().endsWith(`/${wanted}`),
    );
    if (exact) return await readOntology(client, exact.uri);

    const domains = new Set<string>();
    for (const r of resources) {
      const m = /^ontology:\/\/([^/]+)/.exec(r.uri);
      if (m) domains.add(m[1]!);
    }
    for (const domain of domains) {
      const hit = await readOntology(client, `ontology://${domain}/${type}`).catch(() => null);
      if (hit) return hit;
    }
  } catch {
    /* no resources / not supported */
  }
  return null;
}

export async function buildSystemPrompt(client: Client): Promise<string> {
  // The MCP server ships tool-usage guidance in its `initialize` instructions; fold it
  // in so server-side changes reach the model without editing this prompt.
  const serverInstructions = client.getInstructions()?.trim();
  const base = serverInstructions ? `${PERSONA}\n\n${serverInstructions}` : PERSONA;
  try {
    const { content, isError } = await callTool(client, 'list_entity_types', {});
    if (isError || !content) return base;
    return `${base}\n\nEntity types currently in the broker:\n${content}`;
  } catch {
    return base;
  }
}
