import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { streamChat } from './api';
import type { AgentEvent, Msg, ToolCall, ToolResult } from '../shared/types';

interface ProviderInfo {
  id: string;
  models: string[];
}
interface PromptInfo {
  name: string;
  description?: string;
}

type Turn =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; call: ToolCall; result?: ToolResult };

export function App() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [prompts, setPrompts] = useState<PromptInfo[]>([]);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/providers')
      .then((r) => r.json())
      .then((d: { providers: ProviderInfo[]; default: string }) => {
        setProviders(d.providers);
        setProvider(d.default);
      })
      .catch(() => undefined);
    fetch('/api/prompts')
      .then((r) => r.json())
      .then((d: { prompts: PromptInfo[] }) => setPrompts(d.prompts ?? []))
      .catch(() => undefined);
  }, []);

  const models = useMemo(
    () => providers.find((p) => p.id === provider)?.models ?? [],
    [providers, provider],
  );
  useEffect(() => {
    setModel(models[0] ?? '');
  }, [models]);

  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [turns]);

  async function send(text: string) {
    if (!text.trim() || busy || !provider) return;
    setInput('');
    let acc: Turn[] = [...turns, { kind: 'user', text }];
    setTurns(acc);
    setBusy(true);
    setThinking(true);

    const history = wireHistory(acc);
    let assistantOpen = false;
    const apply = (fn: (prev: Turn[]) => Turn[]) => {
      acc = fn(acc);
      setTurns(acc);
    };

    try {
      await streamChat({ messages: history, provider, model }, (e: AgentEvent) => {
        if (e.t === 'token') {
          setThinking(false);
          if (!assistantOpen) {
            apply((p) => [...p, { kind: 'assistant', text: '' }]);
            assistantOpen = true;
          }
          apply((p) =>
            p.map((t, i) =>
              i === p.length - 1 && t.kind === 'assistant' ? { ...t, text: t.text + e.text } : t,
            ),
          );
        } else if (e.t === 'assistant_done') {
          assistantOpen = false;
        } else if (e.t === 'tool_call') {
          apply((p) => [...p, { kind: 'tool', call: e.call }]);
          setThinking(true);
        } else if (e.t === 'tool_result') {
          apply((p) =>
            p.map((t) =>
              t.kind === 'tool' && t.call.id === e.result.id ? { ...t, result: e.result } : t,
            ),
          );
          setThinking(true);
        } else if (e.t === 'error') {
          apply((p) => [...p, { kind: 'assistant', text: `⚠️ ${e.message}` }]);
        }
      });
    } finally {
      setBusy(false);
      setThinking(false);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>&#127806; Smart Farm FMIS</h1>
        <div className="pickers">
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </header>

      {prompts.length > 0 && (
        <div className="prompts">
          {prompts.map((p) => (
            <button
              key={p.name}
              title={p.description}
              onClick={() => setInput(p.description || p.name)}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}

      <div className="chat">
      <div className="log" ref={scroller}>
        {turns.map((t, i) => {
          if (t.kind === 'user') {
            return (
              <div key={i} className="msg user">
                {t.text}
              </div>
            );
          }
          if (t.kind === 'assistant') {
            return (
              <div key={i} className="msg assistant">
                <Markdown remarkPlugins={[remarkGfm]}>{t.text}</Markdown>
              </div>
            );
          }
          return (
            <details key={i} className="tool">
              <summary className="tool-head">
                <span className="tool-badge">tool</span>
                <span className="tool-name">{t.call.name}</span>
                <span
                  className={
                    'tool-status ' +
                    (!t.result ? 'running' : t.result.isError ? 'error' : 'ok')
                  }
                >
                  {!t.result ? 'running…' : t.result.isError ? 'error' : 'ok'}
                </span>
              </summary>
              <div className="tool-body">
                {Object.keys(t.call.args ?? {}).length > 0 && (
                  <pre className="tool-args">{JSON.stringify(t.call.args, null, 2)}</pre>
                )}
                {t.result ? (
                  <pre className={t.result.isError ? 'tool-out err' : 'tool-out'}>
                    {t.result.content}
                  </pre>
                ) : (
                  <pre className="tool-out dim">running&#8230;</pre>
                )}
              </div>
            </details>
          );
        })}
        {thinking && (
          <div className="msg assistant thinking">
            <span className="spinner" />
            thinking&#8230;
          </div>
        )}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          placeholder="Ask about the farm…"
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button disabled={busy || !input.trim()}>Send</button>
      </form>
      </div>
    </div>
  );
}

/** Rebuild the provider-agnostic wire history from the displayed turns. */
function wireHistory(all: Turn[]): Msg[] {
  const msgs: Msg[] = [];
  let i = 0;
  while (i < all.length) {
    const t = all[i]!;
    if (t.kind === 'user') {
      msgs.push({ role: 'user', text: t.text });
      i++;
    } else if (t.kind === 'assistant') {
      msgs.push({ role: 'assistant', text: t.text });
      i++;
    } else {
      const calls: ToolCall[] = [];
      const results: ToolResult[] = [];
      while (i < all.length && all[i]!.kind === 'tool') {
        const tt = all[i] as Extract<Turn, { kind: 'tool' }>;
        calls.push(tt.call);
        if (tt.result) results.push(tt.result);
        i++;
      }
      msgs.push({ role: 'assistant', text: '', toolCalls: calls });
      msgs.push({ role: 'tool', results });
    }
  }
  return msgs;
}
