import type { LlmProvider } from '../../shared/types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatProvider } from './openai-compat.js';

export interface Registry {
  defaultId: string;
  all(): LlmProvider[];
  get(id?: string): LlmProvider | undefined;
}

const env = (name: string): string | undefined => process.env[name] || undefined;

export function buildRegistry(): Registry {
  const providers = new Map<string, LlmProvider>();

  if (env('ANTHROPIC_API_KEY')) {
    providers.set(
      'anthropic',
      new AnthropicProvider(
        process.env.ANTHROPIC_API_KEY!,
        env('ANTHROPIC_MODEL') ?? 'claude-sonnet-5',
        env('ANTHROPIC_BASE_URL'),
      ),
    );
  }

  if (env('OPENAI_API_KEY')) {
    providers.set(
      'openai',
      new OpenAiCompatProvider({
        id: 'openai',
        apiKey: process.env.OPENAI_API_KEY!,
        baseURL: env('OPENAI_BASE_URL'),
        defaultModel: env('OPENAI_MODEL') ?? 'gpt-4o',
      }),
    );
  }

  if (env('OLLAMA_BASE_URL')) {
    providers.set(
      'ollama',
      new OpenAiCompatProvider({
        id: 'ollama',
        baseURL: process.env.OLLAMA_BASE_URL!,
        apiKey: 'ollama',
        defaultModel: env('OLLAMA_MODEL') ?? 'qwen2.5:7b',
      }),
    );
  }

  if (env('GEMINI_API_KEY')) {
    providers.set(
      'gemini',
      new OpenAiCompatProvider({
        id: 'gemini',
        baseURL: env('GEMINI_BASE_URL') ?? 'https://generativelanguage.googleapis.com/v1beta/openai/',
        apiKey: process.env.GEMINI_API_KEY!,
        defaultModel: env('GEMINI_MODEL') ?? 'gemini-2.0-flash',
      }),
    );
  }

  if (!providers.size) {
    throw new Error(
      'No LLM provider configured. Set ANTHROPIC_API_KEY (or OPENAI_API_KEY / OLLAMA_BASE_URL / GEMINI_API_KEY).',
    );
  }

  const keys = [...providers.keys()];
  const wanted = env('PROVIDER');
  const defaultId = wanted && providers.has(wanted) ? wanted : keys[0]!;

  return {
    defaultId,
    all: () => [...providers.values()],
    get: (id) => providers.get(id ?? defaultId),
  };
}
