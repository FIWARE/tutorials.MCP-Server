export const config = {
  port: Number(process.env.PORT ?? '3005'),
  mcpUrl: process.env.MCP_URL ?? 'http://localhost:3003/mcp',
};
