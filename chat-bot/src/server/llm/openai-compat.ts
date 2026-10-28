import OpenAI from 'openai';
import type { ChatRequest, Delta, LlmProvider, Msg } from '../../shared/types.js';

interface Opts {
  id: string;
  apiKey: string;
  /** Explicit pin; skips discovery. */
  model?: string;
  /** Patterns tried against the provider's model list; the last (newest-sorting) match wins. */
  prefer?: RegExp[];
  baseURL?: string;
}

/** With `prefer`, a miss is an error; without it, the first listed model is used. */
export function pickModel(id: string, ids: string[], prefer?: RegExp[]): string {
  if (!prefer?.length) {
    if (!ids[0]) throw new Error(`${id}: no models available`);
    return ids[0];
  }
  for (const re of prefer) {
    const hit = [...ids].reverse().find((m) => re.test(m));
    if (hit) return hit;
  }
  throw new Error(`${id}: no model matches ${prefer.join(', ')}; set ${id.toUpperCase()}_MODEL`);
}

/** Serves any OpenAI-compatible endpoint: OpenAI itself, Ollama, Gemini's /v1beta/openai/. */
export class OpenAiCompatProvider implements LlmProvider {
  readonly id: string;
  #client: OpenAI;
  #model?: string;
  #prefer?: RegExp[];

  constructor(opts: Opts) {
    this.id = opts.id;
    this.#client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.#model = opts.model;
    this.#prefer = opts.prefer;
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await this.#client.models.list();
      const ids = res.data.map((m) => m.id).sort();
      if (ids.length) return ids;
    } catch {
      // fall through to the pin, if any
    }
    return this.#model ? [this.#model] : [];
  }

  async defaultModel(): Promise<string> {
    this.#model ??= pickModel(this.id, await this.listModels(), this.#prefer);
    return this.#model;
  }

  async *stream(req: ChatRequest): AsyncIterable<Delta> {
    const stream = await this.#client.chat.completions.create({
      model: req.model ?? (await this.defaultModel()),
      stream: true,
      messages: toOpenAi(req.system, req.messages),
      tools: req.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema as Record<string, unknown>,
        },
      })),
    });

    const pending = new Map<number, { id: string; name: string; args: string; extra?: unknown }>();
    let stop: 'tool_use' | 'end' = 'end';

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.delta?.content) yield { type: 'text', text: choice.delta.content };

      for (const tc of choice.delta?.tool_calls ?? []) {
        // Gemini omits `index` on streamed tool calls; without it every call would merge into one slot.
        const key =
          tc.index ??
          (tc.id || tc.function?.name
            ? ([...pending].find(([, v]) => tc.id && v.id === tc.id)?.[0] ?? pending.size)
            : Math.max(pending.size - 1, 0));
        const slot = pending.get(key) ?? { id: '', name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        const extra = (tc as { extra_content?: unknown }).extra_content;
        if (extra) slot.extra = extra;
        pending.set(key, slot);
      }

      if (choice.finish_reason === 'tool_calls') stop = 'tool_use';
    }

    for (const slot of pending.values()) {
      yield {
        type: 'tool_call',
        call: { id: slot.id, name: slot.name, args: safeParse(this.id, slot.name, slot.args), extra: slot.extra },
      };
    }
    yield { type: 'done', stopReason: stop };
  }
}

function safeParse(provider: string, tool: string, s: string): Record<string, unknown> {
  try {
    return s ? (JSON.parse(s) as Record<string, unknown>) : {};
  } catch {
    console.error(`${provider}: unparseable arguments for ${tool}: ${s.slice(0, 300)}`);
    return {};
  }
}

function toOpenAi(
  system: string,
  messages: Msg[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: system }];

  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        tool_calls: m.toolCalls?.length
          ? m.toolCalls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
              ...(c.extra ? { extra_content: c.extra } : {}),
            }))
          : undefined,
      });
    } else {
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
    }
  }
  return out;
}
