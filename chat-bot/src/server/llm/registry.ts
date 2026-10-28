import type { LlmProvider } from '../../shared/types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatProvider } from './openai-compat.js';

export interface Registry {
  defaultId: string;
  all(): LlmProvider[];
  get(id?: string): LlmProvider | undefined;
}

const env = (name: string): string | undefined => process.env[name] || undefined;

// Models are discovered from each provider's /models list; `prefer` picks among them.
// Set <ID>_MODEL to pin one.
const COMPAT = [
  { id: 'openai', url: undefined, prefer: [/^gpt-4o$/] },
  { id: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/', prefer: [/gemini-[\d.]+-flash$/] },
  { id: 'groq', url: 'https://api.groq.com/openai/v1', prefer: [/gpt-oss-120b$/] },
  { id: 'openrouter', url: 'https://openrouter.ai/api/v1', prefer: [/llama-3\.3-70b-instruct(:free)?$/] },
  { id: 'nvidia', url: 'https://integrate.api.nvidia.com/v1', prefer: [/llama-3\.3-70b-instruct$/] },
  { id: 'cohere', url: 'https://api.cohere.ai/compatibility/v1', prefer: [/command-r-plus/] },
];

export function buildRegistry(): Registry {
  const providers = new Map<string, LlmProvider>();

  if (env('ANTHROPIC_API_KEY')) {
    providers.set(
      'anthropic',
      new AnthropicProvider(process.env.ANTHROPIC_API_KEY!, env('ANTHROPIC_MODEL'), env('ANTHROPIC_BASE_URL')),
    );
  }

  for (const p of COMPAT) {
    const U = p.id.toUpperCase();
    const apiKey = env(`${U}_API_KEY`);
    if (!apiKey) continue;
    providers.set(
      p.id,
      new OpenAiCompatProvider({
        id: p.id,
        apiKey,
        baseURL: env(`${U}_BASE_URL`) ?? p.url,
        model: env(`${U}_MODEL`),
        prefer: p.prefer,
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
        model: env('OLLAMA_MODEL'),
      }),
    );
  }

  if (!providers.size) {
    throw new Error(
      'No LLM provider configured. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, NVIDIA_API_KEY, COHERE_API_KEY, OLLAMA_BASE_URL.',
    );
  }

  const keys = [...providers.keys()];
  const wanted = env('PROVIDER');
  // Ollama is a fallback only: default to it solely when it is the one provider loaded.
  // An explicit PROVIDER=ollama still wins.
  const autoDefault = keys.find((k) => k !== 'ollama') ?? keys[0]!;
  const defaultId = wanted && providers.has(wanted) ? wanted : autoDefault;
  if (wanted && !providers.has(wanted)) {
    console.warn(
      `chat-bot: PROVIDER=${wanted} is not enabled (no API key or unknown provider); falling back to ${defaultId}`,
    );
  }

  return {
    defaultId,
    all: () => [...providers.values()],
    get: (id) => providers.get(id ?? defaultId),
  };
}
