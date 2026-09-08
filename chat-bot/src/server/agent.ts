import type {
  AgentEvent,
  LlmProvider,
  McpToolDef,
  Msg,
  ToolCall,
  ToolResult,
} from '../shared/types.js';

const CREATE_TOOL = 'create_entity';

interface RunOpts {
  provider: LlmProvider;
  model?: string;
  system: string;
  tools: McpToolDef[];
  history: Msg[];
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: string; isError: boolean }>;
  /** Ports the .claude PreToolUse hook: fetch the data model for an entity type before it is created. */
  lookupOntology?: (type: string) => Promise<{ uri: string; text: string } | null>;
  maxSteps?: number;
}

export async function* runAgent(opts: RunOpts): AsyncGenerator<AgentEvent> {
  const { provider, model, system, tools, callTool } = opts;
  const messages: Msg[] = [...opts.history];
  const maxSteps = opts.maxSteps ?? 10;
  const surfaced = seedSurfaced(opts.history);

  for (let step = 0; step < maxSteps; step++) {
    let text = '';
    const toolCalls: ToolCall[] = [];

    for await (const d of provider.stream({ system, messages, tools, model })) {
      if (d.type === 'text') {
        text += d.text;
        yield { t: 'token', text: d.text };
      } else if (d.type === 'tool_call') {
        toolCalls.push(d.call);
      }
    }

    messages.push({
      role: 'assistant',
      text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    });
    yield { t: 'assistant_done', text };

    if (!toolCalls.length) return;

    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      yield { t: 'tool_call', call };

      const guard = await ontologyGuard(call, surfaced, opts.lookupOntology);
      if (guard) {
        results.push(guard);
        yield { t: 'tool_result', result: guard };
        continue;
      }

      const r = await callTool(call.name, call.args);
      const result: ToolResult = { id: call.id, content: r.content, isError: r.isError };
      results.push(result);
      yield { t: 'tool_result', result };
    }
    messages.push({ role: 'tool', results });
  }

  yield { t: 'error', message: `Stopped after ${maxSteps} tool-loop steps` };
}

/** Recover which entity types already had their model surfaced earlier in the conversation. */
function seedSurfaced(history: Msg[]): Set<string> {
  const seen = new Set<string>();
  for (const m of history) {
    if (m.role !== 'tool') continue;
    for (const r of m.results) {
      const hit = /\[ontology-model:([^\]]+)\]/.exec(r.content);
      if (hit) seen.add(hit[1]!.toLowerCase());
    }
  }
  return seen;
}

async function ontologyGuard(
  call: ToolCall,
  surfaced: Set<string>,
  lookup?: RunOpts['lookupOntology'],
): Promise<ToolResult | null> {
  if (call.name !== CREATE_TOOL || !lookup) return null;
  const type = entityType(call.args);
  if (!type || surfaced.has(type.toLowerCase())) return null;

  surfaced.add(type.toLowerCase());
  const onto = await lookup(type).catch(() => null);
  const content = onto
    ? `[ontology-model:${type}] This create was not executed. Data model for "${type}" from ${onto.uri} follows. ` +
      `Rebuild the entity on these field names, keeping any extras as clearly-labelled extension fields, ` +
      `then call ${CREATE_TOOL} again.\n\n${onto.text}`
    : `[ontology-model:${type}] This create was not executed. No published data model was found for "${type}". ` +
      `Keep attribute names conventional, label any non-standard fields clearly, then call ${CREATE_TOOL} again.`;

  return { id: call.id, content, isError: true };
}

function entityType(args: Record<string, unknown>): string | undefined {
  if (typeof args.type === 'string') return args.type;
  const entity = args.entity;
  if (entity && typeof entity === 'object') {
    const t = (entity as Record<string, unknown>).type;
    if (typeof t === 'string') return t;
  }
  return undefined;
}
