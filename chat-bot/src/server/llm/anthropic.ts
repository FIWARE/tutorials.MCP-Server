import Anthropic from '@anthropic-ai/sdk';
import { pickModel } from './openai-compat.js';
import type { ChatRequest, Delta, LlmProvider, Msg } from '../../shared/types.js';

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  #client: Anthropic;
  #model?: string;

  constructor(apiKey: string, model?: string, baseURL?: string) {
    this.#client = new Anthropic({ apiKey, baseURL });
    this.#model = model;
  }

  async listModels(): Promise<string[]> {
    try {
      // The API lists newest first; keep that order so the newest match wins below.
      const ids: string[] = [];
      for await (const m of this.#client.models.list()) ids.push(m.id);
      if (ids.length) return ids;
    } catch {
      // fall through to the pin, if any
    }
    return this.#model ? [this.#model] : [];
  }

  async defaultModel(): Promise<string> {
    if (!this.#model) {
      const ids = await this.listModels();
      this.#model = pickModel(this.id, [...ids].reverse(), [/sonnet/]);
    }
    return this.#model;
  }

  async *stream(req: ChatRequest): AsyncIterable<Delta> {
    const stream = this.#client.messages.stream({
      model: req.model ?? (await this.defaultModel()),
      max_tokens: 4096,
      system: req.system,
      messages: toAnthropic(req.messages),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
      })),
    });

    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        yield { type: 'text', text: ev.delta.text };
      }
    }

    const final = await stream.finalMessage();
    for (const block of final.content) {
      if (block.type === 'tool_use') {
        yield {
          type: 'tool_call',
          call: {
            id: block.id,
            name: block.name,
            args: (block.input ?? {}) as Record<string, unknown>,
          },
        };
      }
    }
    yield { type: 'done', stopReason: final.stop_reason === 'tool_use' ? 'tool_use' : 'end' };
  }
}

function toAnthropic(messages: Msg[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === 'user') return { role: 'user', content: m.text };

    if (m.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      }
      if (!content.length) content.push({ type: 'text', text: '(no output)' });
      return { role: 'assistant', content };
    }

    return {
      role: 'user',
      content: m.results.map(
        (r): Anthropic.ToolResultBlockParam => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.content,
          is_error: r.isError,
        }),
      ),
    };
  });
}
