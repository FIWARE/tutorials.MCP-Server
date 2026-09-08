export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  content: string;
  isError: boolean;
}

export type Msg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] };

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type Delta =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; stopReason: 'tool_use' | 'end' };

export interface ChatRequest {
  system: string;
  messages: Msg[];
  tools: McpToolDef[];
  model?: string;
}

export interface LlmProvider {
  id: string;
  listModels(): Promise<string[]>;
  stream(req: ChatRequest): AsyncIterable<Delta>;
}

export type AgentEvent =
  | { t: 'token'; text: string }
  | { t: 'assistant_done'; text: string }
  | { t: 'tool_call'; call: ToolCall }
  | { t: 'tool_result'; result: ToolResult }
  | { t: 'error'; message: string }
  | { t: 'end' };
