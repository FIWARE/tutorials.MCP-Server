# FIWARE NGSI-LD Step-by-Step Tutorials Chat Bot

A React + Express reference client for the [`mcp-server`](../../mcp-server): a web chat UI that lets an LLM answer
questions about the Smart Farm by calling the MCP server's tools, backed by whichever provider (Anthropic, OpenAI,
Ollama, Gemini) is configured.

With `AUTH_ENABLED=true` it signs the user in against the configured OpenID Connect provider (authorization code +
PKCE, endpoints read from its discovery document) — Keycloak in the tutorial
and holds the resulting access token server-side, so the MCP session — and therefore the tools it can see and call —
reflects that user's own roles, not a shared service account. Unset (the tutorial default), it connects to the MCP
server anonymously.

## Features

- **Multi-provider**: any provider whose API key (or, for Ollama, base URL) is set in the environment is available
  to pick per-request; `PROVIDER` names the default.
- **Per-user MCP session**: one MCP connection per signed-in browser session (`mcp-pool.ts`), rebuilt on login so a
  new identity never inherits the previous user's tools or system prompt.
- **Data model bridge**: `list_data_models` / `read_data_model` are synthesised on top of the MCP server's
  `ontology://` resources, so the agent can look up a type's schema as a tool call.
- **Streaming chat**: `/api/chat` is a server-sent-events stream of the agent's tool calls and reply text.

## Environment Variables

- `PORT` - Port the server listens on. Default: `3005`.
- `MCP_URL` - MCP server endpoint. Default: `http://localhost:3003/mcp`.
- `AUTH_ENABLED` - `true` requires OIDC sign-in; unset connects to the MCP server anonymously.
- `SESSION_SECRET` - Express session cookie secret.
- `OIDC_ISSUER` / `OIDC_PUBLIC_ISSUER` - Realm URL as reached from this server vs. from the browser; the discovery
  document's endpoints are split between the two accordingly. Default to the same in-network address.
- `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` / `OIDC_SCOPE` - Client credentials for the
  authorization code exchange.
- `PROVIDER` - Default LLM provider: `anthropic` | `openai` | `ollama` | `gemini`.
- `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`, and the equivalent `OPENAI_*`, `OLLAMA_*`,
  `GEMINI_*` triples - A provider is only registered when its key (or, for Ollama, its base URL) is set.

## Running

```console
npm install
npm run build
npm start
```

Local development (hot-reloading server + Vite dev server):

```console
npm run dev
```

`.env.example` covers the standalone case — running this app directly on the host, against the broker (and, once
`../services <broker> --secure` has brought up `docker-compose/security.yml`, Keycloak) started separately. Under
`docker compose` the values instead come from the root `.env`'s `CHAT_BOT_*` variables, mapped onto these names in
`docker-compose/common.yml`. Keycloak, `AUTH_ENABLED` and the APISIX-routed `MCP_URL` are only part of that mapping
when `--secure` is passed — the default (unsecured) run never creates Keycloak and this app talks to the MCP server
directly.

---

## License

[MIT](../LICENSE) © 2026 FIWARE Foundation e.V.
