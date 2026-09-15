import { describe, it, expect } from 'vitest';
import { runAgent } from '../src/server/agent';
import type { AgentEvent, Delta, LlmProvider } from '../src/shared/types';

let nextId = 0;
const call = (name: string) => ({ id: `c${nextId++}`, name, args: {} });

// One entry per model turn: the deltas that turn streams before the loop looks at
// whether a tool call was made.
function scriptedProvider(turns: Delta[][]): LlmProvider {
  let i = 0;
  return {
    id: 'scripted',
    listModels: async () => [],
    stream: async function* () {
      for (const d of turns[i++] ?? []) yield d;
    },
  };
}

// 'fail' always errors; anything else succeeds — lets a test script failure/success
// per round just by naming the tool call.
const callTool = async (name: string) =>
  name === 'fail'
    ? { content: 'not found', isError: true }
    : { content: 'ok', isError: false };

async function collect(turns: Delta[][], opts: Partial<Parameters<typeof runAgent>[0]> = {}) {
  const events: AgentEvent[] = [];
  for await (const e of runAgent({
    provider: scriptedProvider(turns),
    system: 'test',
    tools: [],
    history: [],
    callTool,
    ...opts,
  })) {
    events.push(e);
  }
  return events;
}

const text = (t: string): Delta => ({ type: 'text', text: t });
const toolCall = (name: string): Delta => ({ type: 'tool_call', call: call(name) });

describe('runAgent loop control', () => {
  it('does not stop early on a bulk task that keeps succeeding, even with stray hedges between rounds', async () => {
    // Old behaviour: nudges never reset, so 4 hedges anywhere in the run (even with
    // successful tool rounds in between) would exhaust maxNudges=3 and cut the task short.
    const turns: Delta[][] = [
      [text('Let me check the herd list.')], // hedge -> nudge 1
      [toolCall('lookup')], // round 1: success, resets nudges
      [text('Now let me check the next one.')], // hedge -> nudge 1 again (reset)
      [toolCall('lookup')], // round 2: success, resets nudges
      [text('Let me check the last one.')], // hedge -> nudge 1 again (reset)
      [toolCall('lookup')], // round 3: success, resets nudges
      [text('Let me confirm the last one.')], // hedge -> nudge 1 again (reset)
      [text('All 30 animals have complete history records.')], // real final answer
    ];

    const events = await collect(turns);

    expect(events.some((e) => e.t === 'error')).toBe(false);
    expect(events.filter((e) => e.t === 'tool_call')).toHaveLength(3);
    const last = events.filter((e) => e.t === 'assistant_done').at(-1);
    expect(last).toMatchObject({ text: 'All 30 animals have complete history records.' });
  });

  it('stops promptly and distinctly on repeated tool failures, without exhausting the step budget', async () => {
    const turns: Delta[][] = Array.from({ length: 10 }, () => [toolCall('fail')]);

    const events = await collect(turns, { maxConsecutiveFailures: 3 });

    const toolRounds = events.filter((e) => e.t === 'tool_call');
    expect(toolRounds).toHaveLength(3); // stopped after the 3rd consecutive failed round, not all 10
    const last = events.at(-1);
    expect(last).toMatchObject({ t: 'error', message: expect.stringContaining('3 consecutive failed') });
  });

  it('a single failure does not trip the failure stop when a success follows', async () => {
    const turns: Delta[][] = [
      [toolCall('fail')],
      [toolCall('lookup')], // resets the failure streak
      [toolCall('fail')],
      [text('Found one record; the other animal has none on file.')],
    ];

    const events = await collect(turns, { maxConsecutiveFailures: 3 });

    expect(events.some((e) => e.t === 'error')).toBe(false);
  });

  it('an immediate final answer with no tool calls ends the loop in one step', async () => {
    const turns: Delta[][] = [[text('The farm has 12 parcels.')]];

    const events = await collect(turns);

    expect(events).toEqual([
      { t: 'token', text: 'The farm has 12 parcels.' },
      { t: 'assistant_done', text: 'The farm has 12 parcels.' },
    ]);
  });

  it('maxSteps still backstops a loop that keeps succeeding but never concludes', async () => {
    const turns: Delta[][] = Array.from({ length: 5 }, () => [toolCall('lookup')]);

    const events = await collect(turns, { maxSteps: 5 });

    const last = events.at(-1);
    expect(last).toMatchObject({ t: 'error', message: expect.stringContaining('5 tool-loop steps') });
  });
});
