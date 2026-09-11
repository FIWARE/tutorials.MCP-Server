import type {
  AgentEvent,
  LlmProvider,
  McpToolDef,
  Msg,
  ToolCall,
  ToolResult,
} from '../shared/types.js';

const CREATE_TOOL = 'create_entity';

const CONTINUE_NUDGE =
  'Keep going — do not stop at a description of your next step. In THIS turn, make the tool call ' +
  'you just described. If a previous call failed or returned nothing, recover: call list_entity_types ' +
  'for the real type names and list_attributes for the real attribute names, or broaden/relax the ' +
  'query, then retry. Only give a final answer once you actually have one or have genuinely ' +
  'exhausted the available tools.';

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
  /** How many times to auto-prompt the model to continue when it stalls without a tool call. */
  maxNudges?: number;
}

export async function* runAgent(opts: RunOpts): AsyncGenerator<AgentEvent> {
  const { provider, model, system, tools, callTool } = opts;
  const messages: Msg[] = [...opts.history];
  const maxSteps = opts.maxSteps ?? 16;
  const maxNudges = opts.maxNudges ?? 3;
  const surfaced = seedSurfaced(opts.history);

  let nudges = 0;
  let lastToolErrored = false;
  let toolCallsMade = 0;

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

    if (!toolCalls.length) {
      // No tool call this turn. Prod it to continue if it was mid-investigation, just
      // hit an error, or gave up early — don't accept a premature answer.
      const wantMore =
        lastToolErrored ||
        wantsToContinue(text) ||
        (toolCallsMade < 4 && looksLikeDeadEnd(text));
      if (nudges < maxNudges && wantMore) {
        nudges++;
        lastToolErrored = false;
        messages.push({ role: 'user', text: CONTINUE_NUDGE });
        continue;
      }
      return;
    }

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
      const result = completenessNudge(call, { id: call.id, content: r.content, isError: r.isError });
      results.push(result);
      yield { t: 'tool_result', result };
    }
    lastToolErrored = results.some((r) => r.isError);
    toolCallsMade += toolCalls.length;
    messages.push({ role: 'tool', results });
  }

  yield { t: 'error', message: `Stopped after ${maxSteps} tool-loop steps` };
}

/** Heuristic: did the model announce a next action (but not take it) or trail off mid-thought? */
function wantsToContinue(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  if (t.endsWith('...') || t.endsWith(':')) return true;
  return (
    /(^|[.\n]\s*)(let me\b|let's\b|i'?ll\b|i will\b|next,? i\b|now i\b|first,? (let|i)\b)/.test(t) ||
    /\b(investigate|let me (check|list|look|see|try|find|verify)|list (all|the) entity types|check what attributes|try (a different|another|again)|as a next step)\b/.test(t)
  );
}

/** Heuristic: a "nothing found / cannot tell" answer that may just mean the model gave up early. */
function looksLikeDeadEnd(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    /\bno .{0,24}(found|registered|recorded|present|matching|match|exist|available)\b/.test(t) ||
    /\b(there (are|is) no|none (were|are)|not (found|registered|recorded|present|available))\b/.test(t) ||
    /\b(couldn'?t|could not|cannot|can'?t|unable to) (find|determine|tell|confirm|verify)\b/.test(t)
  );
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

// Guardrail sibling to ontologyGuard: after a successful create, raise what the model
// tends to skip — derivable attributes, relationships on OTHER entities, and gaps to surface to the user.
function completenessNudge(call: ToolCall, result: ToolResult): ToolResult {
  if (call.name !== CREATE_TOOL || result.isError) return result;
  let attrs: string[] = [];
  try {
    attrs = (JSON.parse(result.content) as { attributes?: string[] }).attributes ?? [];
  } catch {
    return result;
  }
  if (!attrs.length) return result;

  return {
    ...result,
    content:
      `${result.content}\n\n[completeness-check] Attributes set: ${attrs.join(', ')}. Before moving on:\n` +
      "1. Can the type's other optional attributes be computed from data you already retrieved this " +
      'conversation (an average of values you just fetched, a count from entities you just listed)? Add ' +
      'those with update_entity_attribute. Do not invent a value you have no evidence for (an assumed ' +
      'timestamp, a count assumed zero) — leave those unset.\n' +
      '2. If this entity is meant to contain, enclose, or otherwise relate to specific other entities you ' +
      'already have the IDs for, it may hold no relationship back to them — membership is often expressed ' +
      "the other way (e.g. an Animal's locatedAt pointing at this entity, not this entity listing its " +
      'animals). If that is what was asked, update those other entities now.\n' +
      '3. Whatever is still unset once you have done 1 and 2, because you genuinely do not have the data ' +
      '(e.g. ownedBy, a relationship to a person or building) — say so in your final answer and offer to ' +
      'add it, naming what you would need (e.g. "Would you like me to set ownedBy? Who owns this animal?").',
  };
}

function entityType(args: Record<string, unknown>): string | undefined {
  if (typeof args.entityType === 'string') return args.entityType;
  if (typeof args.type === 'string') return args.type;
  const entity = args.entity;
  if (entity && typeof entity === 'object') {
    const t = (entity as Record<string, unknown>).type;
    if (typeof t === 'string') return t;
  }
  return undefined;
}
