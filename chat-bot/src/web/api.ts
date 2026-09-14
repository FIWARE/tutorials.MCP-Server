import type { AgentEvent, Msg } from '../shared/types';

export interface Me {
  authEnabled: boolean;
  user: string | null;
  roles: string[];
}

// 401 means "show the login screen", not "something broke".
export async function getMe(): Promise<Me | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  return res.ok ? ((await res.json()) as Me) : null;
}

export async function logout(): Promise<void> {
  await fetch('/logout', { method: 'POST', credentials: 'same-origin' });
}

export class NotSignedIn extends Error {}

export async function streamChat(
  body: { messages: Msg[]; provider?: string; model?: string },
  onEvent: (e: AgentEvent) => void,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new NotSignedIn('session expired');
  if (!res.body) throw new Error('no response stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.replace(/^data: /, '').trim();
      if (line) onEvent(JSON.parse(line) as AgentEvent);
    }
  }
}
