import OpenAI from 'openai';
import type { ChatRequest, Delta, LlmProvider, Msg } from '../../shared/types.js';

interface Opts {
  id: string;
  apiKey: string;
  defaultModel: string;
  baseURL?: string;
}

/** Serves any OpenAI-compatible endpoint: OpenAI itself, Ollama, Gemini's /v1beta/openai/. */
export class OpenAiCompatProvider implements LlmProvider {
  readonly id: string;
  #client: OpenAI;
  #model: string;

  constructor(opts: Opts) {
    this.id = opts.id;
    this.#client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.#model = opts.defaultModel;
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await this.#client.models.list();
      const ids = res.data.map((m) => m.id).sort();
      return ids.length ? ids : [this.#model];
    } catch {
      return [this.#model];
    }
  }

  async *stream(req: ChatRequest): AsyncIterable<Delta> {
    const stream = await this.#client.chat.completions.create({
      model: req.model ?? this.#model,
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

    const pending = new Map<number, { id: string; name: string; args: string }>();
    let stop: 'tool_use' | 'end' = 'end';

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.delta?.content) yield { type: 'text', text: choice.delta.content };

      for (const tc of choice.delta?.tool_calls ?? []) {
        const slot = pending.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        pending.set(tc.index, slot);
      }

      if (choice.finish_reason === 'tool_calls') stop = 'tool_use';
    }

    for (const slot of pending.values()) {
      yield { type: 'tool_call', call: { id: slot.id, name: slot.name, args: safeParse(slot.args) } };
    }
    yield { type: 'done', stopReason: stop };
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return s ? (JSON.parse(s) as Record<string, unknown>) : {};
  } catch {
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
