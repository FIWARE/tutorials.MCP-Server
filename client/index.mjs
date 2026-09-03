#!/usr/bin/env node
//
// Minimal MCP client for the NGSI-LD tutorial stack.
//
//   node index.mjs                                    list tools + resources
//   node index.mjs query_entities '{"type":"Animal"}' call a tool with JSON args
//   node index.mjs get_entity_type '{"type":"Animal"}'
//   MCP_URL=http://mcp-server:3003/mcp node index.mjs (from inside the compose network)
//
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.MCP_URL ?? 'http://localhost:3003/mcp');
const client = new Client({ name: 'ngsi-ld-cli', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(url));

const [tool, ...rest] = process.argv.slice(2);

if (!tool) {
    const { tools } = await client.listTools();
    const { resources } = await client.listResources();
    console.log('tools:\n  ' + tools.map((t) => t.name).join('\n  '));
    console.log('\nresources:\n  ' + resources.map((r) => r.uri).join('\n  '));
} else {
    const args = rest.length ? JSON.parse(rest.join(' ')) : {};
    const res = await client.callTool({ name: tool, arguments: args });
    console.log(JSON.stringify(res, null, 2));
}

await client.close();
