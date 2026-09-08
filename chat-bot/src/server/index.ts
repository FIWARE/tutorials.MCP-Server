import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import {
  buildSystemPrompt,
  callTool,
  connectMcp,
  findOntology,
  listResourceDefs,
  listToolDefs,
  readResourceText,
} from './mcp.js';
import { buildRegistry } from './llm/registry.js';
import { runAgent } from './agent.js';
import type { McpToolDef, Msg } from '../shared/types.js';

const mcp = await connectMcp(config.mcpUrl);
const registry = buildRegistry();
const toolDefs = await listToolDefs(mcp);
const resourceDefs = await listResourceDefs(mcp);
const systemPrompt = await buildSystemPrompt(mcp);

// MCP resources are not tools, so bridge the ontology schemas into callable tools.
const DATA_MODEL_TOOLS: McpToolDef[] = [
  {
    name: 'list_data_models',
    description:
      'List every NGSI-LD data model (ontology schema) available, with its URI. Use to discover which entity types have a documented model.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_data_model',
    description:
      'Read the NGSI-LD data model (ontology schema) for an entity type — the attributes and relationships the type is DESIGNED to carry, which may differ from what is currently populated on the broker. Use for questions about what the farm model supports (e.g. "is animal lineage tracked?", "what attributes can a Parcel have?"). Pass an entity type name like "Animal", or a full ontology:// URI.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Entity type name (e.g. "Animal") or an ontology:// URI' },
      },
      required: ['type'],
    },
  },
];
const agentTools = [...toolDefs, ...DATA_MODEL_TOOLS];

async function callAgentTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  if (name === 'list_data_models') {
    return {
      content: resourceDefs
        .filter((r) => r.uri.startsWith('ontology://'))
        .map((r) => `${r.uri}${r.name ? ` — ${r.name}` : ''}`)
        .join('\n'),
      isError: false,
    };
  }
  if (name === 'read_data_model') {
    const q = String((args as { type?: string }).type ?? '').trim();
    if (!q) return { content: 'type is required', isError: true };
    const hit = q.startsWith('ontology://')
      ? { uri: q, text: await readResourceText(mcp, q).catch((e) => String(e)) }
      : await findOntology(mcp, q);
    return hit && hit.text
      ? { content: `# ${hit.uri}\n\n${hit.text}`, isError: false }
      : { content: `No data model found for "${q}". Try list_data_models.`, isError: true };
  }
  return callTool(mcp, name, args);
}

console.log(
  `chat-bot: ${agentTools.length} tools (${toolDefs.length} MCP + ${DATA_MODEL_TOOLS.length} data-model), ${resourceDefs.length} resources, providers [${registry
    .all()
    .map((p) => p.id)
    .join(', ')}], default ${registry.defaultId}`,
);

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/providers', async (_req, res) => {
  const providers = await Promise.all(
    registry.all().map(async (p) => ({ id: p.id, models: await p.listModels().catch(() => []) })),
  );
  res.json({ providers, default: registry.defaultId });
});

app.get('/api/prompts', async (_req, res) => {
  try {
    const { prompts } = await mcp.listPrompts();
    res.json({ prompts });
  } catch {
    res.json({ prompts: [] });
  }
});

app.post('/api/chat', async (req, res) => {
  const { messages, provider: providerId, model } = req.body as {
    messages: Msg[];
    provider?: string;
    model?: string;
  };
  const provider = registry.get(providerId);
  if (!provider) {
    res.status(400).json({ error: `unknown provider: ${providerId}` });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  try {
    for await (const ev of runAgent({
      provider,
      model,
      system: systemPrompt,
      tools: agentTools,
      history: messages ?? [],
      callTool: callAgentTool,
      lookupOntology: (type) => findOntology(mcp, type),
    })) {
      send(ev);
    }
  } catch (e) {
    send({ t: 'error', message: String(e) });
  }
  send({ t: 'end' });
  res.end();
});

const webDir = fileURLToPath(new URL('../web', import.meta.url));
app.use(express.static(webDir));
app.get('*', (_req, res) => res.sendFile(`${webDir}/index.html`));

app.listen(config.port, () => console.log(`chat-bot listening on :${config.port}`));
