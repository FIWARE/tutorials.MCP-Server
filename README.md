[![FIWARE Banner](https://fiware.github.io/tutorials.Working-with-Linked-Data/img/fiware.png)](https://www.fiware.org/developers)
[![NGSI LD](https://img.shields.io/badge/NGSI-LD-d6604d.svg)](https://www.etsi.org/deliver/etsi_gs/CIM/001_099/009/01.08.01_60/gs_cim009v010801p.pdf)

[![FIWARE Core Context Management](https://nexus.lab.fiware.org/repository/raw/public/badges/chapters/core.svg)](https://github.com/FIWARE/catalogue/blob/master/core/README.md)
[![License: MIT](https://img.shields.io/github/license/fiware/tutorials.MCP-Server.svg)](https://opensource.org/licenses/MIT)
[![Support badge](https://img.shields.io/badge/tag-fiware-orange.svg?logo=stackoverflow)](https://stackoverflow.com/questions/tagged/fiware)
<br/> [![JSON LD](https://img.shields.io/badge/JSON--LD-1.1-f06f38.svg)](https://w3c.github.io/json-ld-syntax/)
[![Documentation](https://img.shields.io/readthedocs/ngsi-ld-tutorials.svg)](https://ngsi-ld-tutorials.rtfd.io)

This tutorial introduces the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) and explains how to place
an MCP server in front of an NGSI-LD Context Broker, so that a Large Language Model can read and alter context data
without being handed the raw API. It covers why the protocol exists, why the server exposes eight data tools rather than
the full NGSI-LD interface, and why JSON Schema data models belong in the middle layer. The server is then connected to
the MCP Inspector, to Claude Desktop, and to a demonstration chat bot, and finally secured behind an API gateway.

[cUrl](https://ec.haxx.se/) commands are used throughout to access the **MCP**, **Keycloak** and **APISIX** APIs.

## Contents

<details>
<summary><strong>Details</strong></summary>

-   [What is the Model Context Protocol?](#what-is-the-model-context-protocol)
    -   [Why an Agent Cannot Simply Read the API Specification](#why-an-agent-cannot-simply-read-the-api-specification)
    -   [Tools, Resources and Prompts](#tools-resources-and-prompts)
-   [Why Only Eight Tools?](#why-only-eight-tools)
    -   [Mapping the Tools onto NGSI-LD](#mapping-the-tools-onto-ngsi-ld)
    -   [What the Server Does So the Agent Does Not](#what-the-server-does-so-the-agent-does-not)
-   [Why Schemas Belong in the Middle Layer](#why-schemas-belong-in-the-middle-layer)
    -   [A Schema-less Broker](#a-schema-less-broker)
    -   [System Attributes and Data Properties](#system-attributes-and-data-properties)
    -   [Discovering What the Broker Holds](#discovering-what-the-broker-holds)
-   [Architecture](#architecture)
-   [Prerequisites](#prerequisites)
    -   [Docker](#docker)
    -   [Cygwin](#cygwin)
    -   [An LLM API Key](#an-llm-api-key)
-   [Start Up](#start-up)
-   [Connecting with the MCP Inspector](#connecting-with-the-mcp-inspector)
-   [Connecting with Claude Desktop](#connecting-with-claude-desktop)
-   [The Chat-bot Demonstration](#the-chat-bot-demonstration)
-   [Securing the MCP Server](#securing-the-mcp-server)
    -   [Dramatis Personae](#dramatis-personae)
    -   [Switching Security On](#switching-security-on)
    -   [APISIX - No Access without an Access Token](#apisix---no-access-without-an-access-token)
    -   [Keycloak - Obtaining an Access Token](#keycloak---obtaining-an-access-token)
    -   [Dynamic Discovery of the Authorization Server](#dynamic-discovery-of-the-authorization-server)
    -   [Role-Based Access to Tools](#role-based-access-to-tools)
    -   [Enforcement at the Context Broker](#enforcement-at-the-context-broker)
    -   [Logging In to the Chat-bot](#logging-in-to-the-chat-bot)
-   [License](#license)

</details>

# Adding an MCP Server to a FIWARE System

> "The single biggest problem in communication is the illusion that it has taken place."
>
> — William H. Whyte

# What is the Model Context Protocol?

A Large Language Model is good at language and bad at facts. Ask it about a farm and it will produce a fluent, confident
paragraph about livestock which has no connection to any actual animal. The fix is not a better model, it is giving the
model a way to look things up - and a way narrow enough that the model cannot get it wrong.

The Model Context Protocol is a published standard for that lookup. An **MCP server** advertises a small set of typed
operations; an **MCP client** - a desktop assistant, an IDE, a chat bot - discovers them at runtime and lets the model
call them. The model never sees a URL, a header or a status code. It sees `query_entities` with a parameter called
`entityType`, and a description explaining when to use it.

## Why an Agent Cannot Simply Read the API Specification

The obvious alternative is to hand the model the NGSI-LD OpenAPI document and let it construct requests. This fails for
reasons worth stating plainly, because they are the reasons the middle layer exists at all:

-   **Size.** The NGSI-LD v1.8.1 API defines **30 paths and 53 operations**. Every one carries parameters, and several
    carry parameters whose values are themselves a grammar. Placing that in a model's context window is expensive and
    displaces the conversation.
-   **Syntax the model will guess at.** NGSI-LD filtering uses its own query language (`q=species=="cow";weight>400`),
    its own geo-query vocabulary (`georel=near;maxDistance==2000`), and a `Link` header carrying a JSON-LD `@context`. A
    model asked to write those by hand produces something plausible and wrong.
-   **No safety boundary.** An API specification describes everything the API can do, including deleting every entity in
    the broker. A tool list describes only what this deployment is willing to allow.
-   **Verbosity in the response.** The default NGSI-LD representation wraps every value in
    `{"type": "Property", "value": ...}`. A page of entities in that form can consume more of the context window than
    the conversation that prompted it.

## Tools, Resources and Prompts

MCP offers three kinds of thing, and this server uses all three:

| Kind          | What it is                                   | In this tutorial                                                   |
| ------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| **Tools**     | Operations the model may call                | Nine, covered below                                                |
| **Resources** | Reference documents the model may read       | 24 `ontology://` JSON Schemas, plus live `ngsi://` broker listings |
| **Prompts**   | Canned workflows a user can pick from the UI | Three, from `prompts/*.json`                                       |

The distinction matters for cost. A tool definition sits in the model's context on **every** turn, so it must stay
small. A resource is read only when the model decides it needs it, so it can be the full JSON Schema for an `Animal`.
Keeping the data models in resources rather than tool descriptions is what makes 24 entity types affordable.

# Why Only Eight Tools?

The server exposes **eight data tools and one discovery tool** - nine in total, against the 53 operations of the API.
The list is short on purpose: an agent choosing between nine clearly-named options is reliable, an agent choosing
between fifty-three is not.

| Tool                         | Purpose                                           |
| ---------------------------- | ------------------------------------------------- |
| `discover_context_meta_data` | What types and attributes exist right now         |
| `get_entity`                 | One entity by URN, optionally with its neighbours |
| `query_entities`             | Search by type and attribute filter               |
| `geoquery_entities`          | Search within a geographic area                   |
| `get_entity_history`         | Values of one entity over time                    |
| `create_entity`              | Create one entity                                 |
| `upsert_attribute`           | Add or update one attribute                       |
| `delete_attribute`           | Remove one attribute                              |
| `delete_entity`              | Delete one entity                                 |

The four write tools are registered only when `WRITABLE=true`. A read-only deployment exposes five tools, and the model
is never told the others exist.

## Mapping the Tools onto NGSI-LD

Each tool is a deliberate narrowing of the API beneath it:

| Tool                 | NGSI-LD request it builds                                                         |
| -------------------- | --------------------------------------------------------------------------------- |
| `query_entities`     | `GET /entities?type=…&q=…&options=concise&count=true&limit=…&offset=…`            |
| `get_entity`         | `GET /entities/{id}?options=concise&pick=…`                                       |
| `geoquery_entities`  | `GET /entities?…&georel=…&geometry=…&coordinates=…`                               |
| `get_entity_history` | `GET {temporal}/temporal/entities/{id}?timerel=…&timeAt=…&options=temporalValues` |
| `create_entity`      | `POST /entities` with a normalised body assembled from simplified input           |
| `upsert_attribute`   | `PATCH /entities/{id}/attrs/{attr}`, falling back to `POST …/attrs` when absent   |

Subscriptions, registrations, batch operations and `@context` management are all absent. They are administrative
concerns rather than conversational ones, and every one of them is a way for an agent to cause damage nobody asked for.

## What the Server Does So the Agent Does Not

The tools are thin; the server behind them is not. Every outbound request is assembled in `mcp-server/lib/ngsi-ld.ts`:

-   **`@context` injection.** The JSON-LD `@context` rides in a `Link` header on every call, built once at start-up. The
    agent never knows it exists.
-   **`options=concise`.** The concise representation drops `"type": "Property"` boilerplate but keeps metadata such as
    `unitCode` and `observedAt` where it exists. This is the format the tools request, and it is why an entity costs a
    fraction of the tokens its normalised form would.
-   **`pick` projection.** The agent asks for the attributes it needs; the server passes them through as `pick`, always
    re-adding `id` and `type` so the result stays identifiable.
-   **Query translation.** `filter` arguments become NGSI-LD `q` syntax, with clauses such as `attr==null` stripped,
    because NGSI-LD has no null literal.
-   **Pagination made visible.** Every query sends `count=true` and returns a `pagination` block. When matches remain,
    the response carries a `_notice` telling the agent to page rather than treat the first page as complete.
-   **Errors as data.** A failure comes back with a `category` (`not_found`, `bad_request`, `auth`, `server`) and a
    `retryable` flag, so the model acts on it instead of apologising.

# Why Schemas Belong in the Middle Layer

## A Schema-less Broker

NGSI-LD does not validate entities against a data model. A `Building` may carry any attribute, or almost none. That is a
deliberate strength of the standard - it is what lets an open system grow - and it is exactly wrong for an LLM, which
needs to know what it may ask for before it asks.

The `schemas/` directory supplies that knowledge: 24 JSON Schema files, mostly
[Smart Data Models](https://smartdatamodels.org/), mounted read-only into the container. They give the server four
things the broker cannot:

1.  **Attribute names worth guessing at.** The agent is told `heartRate` exists on an `Animal` before it tries.
2.  **NGSI-LD typing.** `x-ngsi-type` records whether an attribute is a `Property`, a `Relationship`, a `GeoProperty`
    and so on, which is how the write tools turn `{"ownedBy": "urn:ngsi-ld:Person:001"}` into a correctly formed
    relationship rather than a string.
3.  **Units, enumerations and required fields.** `create_entity` refuses a call missing a required attribute, and
    `discover_context_meta_data` can list the legal values of an enumerated attribute.
4.  **Validation on the way back.** Broker responses are checked against the model. Under the default
    `SCHEMA_VALIDATION=filter` a malformed entity is dropped rather than shown to the agent as fact.

Crucially, a schema describes a type **whether or not any entity of that type exists**. The Smart Farm dataset ships
with no `Pen` and no `AnimalDisease` entity, yet both are fully modelled - so an agent asked to create the first one
knows the shape it must take.

## System Attributes and Data Properties

One distinction causes more confusion than any other, and `schemas/common/common-schema.json` names both sides of it:

| Name                      | What it is                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `createdAt`, `modifiedAt` | NGSI-LD **system attributes**, maintained by the broker. Returned only when `options=sysAttrs` is set. |
| `observedAt`              | NGSI-LD **metadata on an individual attribute**, recording when that value was observed.               |
| `dateObserved`            | An ordinary **data property** defined by a Smart Data Model, stored like any other attribute.          |

The server hides the difference where it can: `pick` one of `createdAt` or `modifiedAt` and it adds `options=sysAttrs`
to the request for you. It cannot hide it inside the data models, which is why the descriptions in the common schema
spell out which is which.

## Discovering What the Broker Holds

Curated schemas are the baseline, not the whole story - a deployment will hold types nobody modelled. With
`DISCOVERY=merge` the server reads the broker's own type list at start-up and fills the gaps, in this order:

1.  A curated schema on disk always wins.
2.  Otherwise the entity type URI is resolved; if it names a published Smart Data Model, that schema is fetched whole.
3.  Only if neither is available is a profile synthesised from `GET /types/{type}`.

A synthesised profile is explicitly marked as partial, because the broker can only report what is populated **today**:
its `required` list is relaxed to `id` and `type`, and its description tells the agent the attribute list is indicative.
The `discover_context_meta_data` tool takes a `refresh` argument to re-run the scan on demand.

# Architecture

The demo uses the [Orion-LD Context Broker](https://fiware-orion.rtfd.io/), which persists context to
[MongoDB](https://www.mongodb.com/) and history to [TimescaleDB](https://www.timescale.com/), read back through
[Mintaka](https://github.com/FIWARE/mintaka). The MCP server sits in front of the broker;
[Keycloak](https://www.keycloak.org/) and [Apache APISIX](https://apisix.apache.org/) are present throughout but only
come into play in the final section.

-   The **Orion-LD Context Broker** receiving [NGSI-LD](https://www.etsi.org/committee/cim) requests
-   The **MCP Server** exposing the broker as tools, resources and prompts
-   The **Chat-bot**, a demonstration client with an LLM agent loop
-   **Apache APISIX** acting as an API Gateway, used in the security section
-   **Keycloak** as the Identity and Access Management server
-   An HTTP **Context** server holding the JSON-LD `@context`

```yaml
mcp-server:
    image: quay.io/fiware/tutorials.mcp-server
    hostname: mcp-server
    container_name: fiware-mcp-server
    ports:
        - "3003:3003"
    environment:
        - MCP_TRANSPORT=http
        - MCP_PORT=3003
        - SCHEMA_DIR=/schemas
        - NGSI_LD_CONTEXT=http://context/user-context.jsonld
        - WRITABLE=true
        - WRITE_TENANT=farmer
        - DISCOVERY=merge
        - AUTH_ENABLED=${AUTH_ENABLED}
    volumes:
        - type: bind
          source: ${PWD}/schemas
          target: /schemas
          read_only: true
```

| Key             | Value                                  | Description                                                     |
| --------------- | -------------------------------------- | --------------------------------------------------------------- |
| MCP_TRANSPORT   | `http`                                 | Serve MCP over HTTP streaming rather than `stdio`               |
| MCP_PORT        | `3003`                                 | The endpoint is mounted at `/mcp`                               |
| SCHEMA_DIR      | `/schemas`                             | Curated JSON Schemas, one per entity type                       |
| NGSI_LD_CONTEXT | `http://context/user-context.jsonld`   | `@context` added to the `Link` header of every broker call      |
| WRITABLE        | `true`                                 | Registers the four write and delete tools                       |
| WRITE_TENANT    | `farmer`                               | `NGSILD-Tenant` used for writes                                 |
| DISCOVERY       | `merge`                                | Add broker-discovered types to the curated ones                 |
| AUTH_ENABLED    | `false` unless started with `--secure` | Whether a bearer token is required, and forwarded to the broker |

> **Note:** as with every tutorial in this series, ports are exposed directly for teaching purposes. Reaching the MCP
> server on `localhost:3003` bypasses the gateway entirely, which is convenient for the sections below and is not how
> the system should be deployed. The warning at the top of each `docker-compose` file says the same thing.

# Prerequisites

## Docker

To keep things simple, all components will be run using [Docker](https://www.docker.com). **Docker** is a container
technology which allows different components to be isolated into their respective environments.

-   To install Docker on Windows follow the instructions [here](https://docs.docker.com/docker-for-windows/)
-   To install Docker on Mac follow the instructions [here](https://docs.docker.com/docker-for-mac/)
-   To install Docker on Linux follow the instructions [here](https://docs.docker.com/install/)

## Cygwin

We will start up our services using a simple bash script. Windows users should download [cygwin](http://www.cygwin.com/)
to provide a command-line functionality similar to a Linux distribution on Windows.

## An LLM API Key

The MCP server and the MCP Inspector need no model. The chat bot does: it runs the agent loop which reads the question,
chooses a tool, calls it and composes the answer, and each of those steps is a request to a hosted Large Language Model.
The model provider authenticates and bills those requests by API key, so the chat bot cannot start without at least one.
Claude Desktop uses its own account and needs no key from this tutorial.

Obtain a key from any one of the providers below and add it to `.env`:

| Provider   | `.env` variable      | Obtain a key from                           |
| ---------- | -------------------- | ------------------------------------------- |
| Anthropic  | `ANTHROPIC_API_KEY`  | https://console.anthropic.com/settings/keys |
| OpenAI     | `OPENAI_API_KEY`     | https://platform.openai.com/api-keys        |
| Gemini     | `GEMINI_API_KEY`     | https://aistudio.google.com/apikey          |
| Groq       | `GROQ_API_KEY`       | https://console.groq.com/keys               |
| OpenRouter | `OPENROUTER_API_KEY` | https://openrouter.ai/keys                  |
| NVIDIA NIM | `NVIDIA_API_KEY`     | https://build.nvidia.com                    |
| Cohere     | `COHERE_API_KEY`     | https://dashboard.cohere.com/api-keys       |

A provider is enabled when its key is set, and several may be enabled together. `CHAT_BOT_PROVIDER` selects the default,
and the chat bot UI can switch between the others. Leave each `*_MODEL` variable blank and the chat bot asks the
provider which models it offers and uses the newest suitable one; set the variable to pin a specific model. Ollama needs
no key (see [The Chat-bot Demonstration](#the-chat-bot-demonstration)).

> **Note:** keep `.env` out of version control once it holds a key, and check each provider for its current pricing and
> free-tier limits before use.

Hosted model names change regularly, so verify the configuration before starting the stack:

```console
./check-models
```

The script calls the model listing endpoint of every provider with a key and prints one line each:

```text
anthropic   OK     9 models; would use claude-sonnet-5-5
openai      skipped (no OPENAI_API_KEY - obtain key from https://platform.openai.com/api-keys)
groq        FAIL   HTTP 401 {"error":{"message":"Invalid API Key"}}
```

-   **OK** - the key works, and the line names the model the chat bot would choose, or confirms that a pinned model is
    available.
-   **FAIL** - the key was rejected, the endpoint was unreachable, or no model matched. In the last case the script
    lists the models on offer so one can be pinned with `*_MODEL`.
-   **skipped** - no key is set for that provider.

Pass provider names to check only those, for example `./check-models groq cohere`.

# Start Up

```console
git clone https://github.com/FIWARE/tutorials.MCP-Server.git
cd tutorials.MCP-Server
git checkout NGSI-LD

./services create
./services orion
```

> **Note:** to clean up and start over:
>
> ```console
> ./services stop
> ```

The MCP server is then reachable at `http://localhost:3003/mcp`, the chat bot at `http://localhost:3006`, and the Smart
Farm web application at `http://localhost:3000/device/monitor`.

# Connecting with the MCP Inspector

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) is the reference client. It is the quickest way
to see what a server offers without involving a model at all, and the right place to start when a tool is not behaving.

#### :one: Request:

```console
npx @modelcontextprotocol/inspector
```

The Inspector opens on `http://localhost:6274`. Add a server with transport **Streamable HTTP** and the URL
`http://localhost:3003/mcp`, then connect.

![MCP Inspector connected](https://fiware.github.io/tutorials.MCP-Server/img/inspector-tools.png)

The **Tools** tab lists the nine tools with their JSON Schema parameters, and each can be run by hand - fill in
`entityType=Animal`, press the button, read the raw response. The **Resources** tab lists the 24 `ontology://` schemas
alongside the live `ngsi://types` and `ngsi://attributes` listings, and the **Prompts** tab the three canned workflows.

![MCP Inspector ontology resource](https://fiware.github.io/tutorials.MCP-Server/img/inspector-resources.png)

Everything the Inspector displays is what a model would be given, which makes it the honest way to judge whether a tool
description is clear enough.

# Connecting with Claude Desktop

[Claude Desktop](https://claude.ai/download) reads its MCP configuration from a JSON file:

-   macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
-   Windows: `%APPDATA%\Claude\claude_desktop_config.json`

The desktop client speaks `stdio` to local servers, so a streamable-HTTP server is reached through the `mcp-remote`
bridge:

#### :two: Configuration:

```json
{
    "mcpServers": {
        "ngsi-ld": {
            "command": "npx",
            "args": ["-y", "mcp-remote", "http://localhost:3003/mcp", "--transport", "http-only"]
        }
    }
}
```

Restart Claude Desktop. The farm tools appear in the tool menu of a new conversation:

![Claude Desktop connector](https://fiware.github.io/tutorials.MCP-Server/img/claude-desktop-connector.png)

Ask it a question about the farm and it will choose a tool, show the call, and answer from the result:

![Claude Desktop answering a farm question](https://fiware.github.io/tutorials.MCP-Server/img/claude-desktop-query.png)

This is the point of the exercise. No application was written. A general-purpose assistant, given nine tools and 24 data
models, is now a competent interface to a Context Broker.

# The Chat-bot Demonstration

The chat bot bundled with this tutorial is a **demonstration of use**, not the subject of it. It is a small React and
Express application doing what Claude Desktop does - connect to the MCP server, list the tools, run an agent loop - so
the behaviour can be seen without installing a desktop client.

> **An API key is required.** The chat bot needs a model to drive the loop. Set at least one provider key in `.env`
> before starting (see [An LLM API Key](#an-llm-api-key)), and pick the provider in the UI.
>
> **Without a key**, `./services ollama` starts a local [Ollama](https://ollama.com/) container and points the chat bot
> at it. This needs no key and costs nothing, but a small local model is slow and noticeably worse at choosing tools.
>
> If neither is convenient, a full worked conversation is published at
> [farm_transcript.html](https://fiware.github.io/tutorials.MCP-Server/farm_transcript.html), showing the tool calls and
> responses exactly as the chat bot produced them.

Open `http://localhost:3006` and ask something that requires looking data up:

![Chat-bot answering a farm question](https://fiware.github.io/tutorials.MCP-Server/img/chat-bot.png)

The interesting part is the tool row in the transcript. The model was asked about heart rates; it called
`query_entities` with `entityType=Animal`, received a concise page of entities, and answered from that. It knew nothing
about any cow until it looked.

# Securing the MCP Server

Everything so far has run open. An MCP server is an API that an autonomous program calls on a user's behalf, driven by
text that user typed - which makes "what happens when the agent is asked to do something it should not" the question
that matters. The answer has to be that it can only ever do what the person asking is allowed to do.

## Dramatis Personae

The `farm-management` realm is created when the tutorial starts. Every account uses the password `test`.

| Name    | Realm role             | What the agent may do on their behalf                             |
| ------- | ---------------------- | ----------------------------------------------------------------- |
| alice   | _none_                 | Administers Keycloak, not the farm                                |
| bob     | `farm-manager`         | Read and write every entity                                       |
| carol   | `livestock-supervisor` | Read everything, write `Animal`, `Water` and `FillingLevelSensor` |
| jenny   | `read-only-consultant` | Read only                                                         |
| mallory | _none_                 | Nothing at all                                                    |

## Switching Security On

Security is a single switch on the `services` script. By default the stack starts unsecured; restart it with `--secure`:

```console
./services orion --secure
```

The script sets four values that the `docker-compose` files read, so nothing in `.env` needs editing:

| Key               | Default                      | With `--secure`              |
| ----------------- | ---------------------------- | ---------------------------- |
| AUTH_ENABLED      | `false`                      | `true`                       |
| MCP_ENDPOINT      | `http://mcp-server:3003/mcp` | `http://apisix:9080/mcp`     |
| BROKER_ENDPOINT   | `http://orion:1026`          | `http://apisix:9080/orion`   |
| TEMPORAL_ENDPOINT | `http://mintaka:8080`        | `http://apisix:9080/mintaka` |

The switch works the same way for `./services scorpio`, `./services stellio` and `./services coraine`: `BROKER_ENDPOINT`
becomes the matching `/scorpio`, `/stellio` or `/coraine` route on APISIX. Scorpio and Stellio serve the temporal
interface themselves, so for them `TEMPORAL_ENDPOINT` follows the broker rather than Mintaka.

Running `./services orion` again without the switch returns the stack to its unsecured state.

With the switch on, three things change. Clients reach the MCP server through APISIX on `http://localhost:1030/mcp`; the
MCP server verifies the bearer token itself, a second time, to decide which tools the caller may see; and it forwards
that same token to the broker, so Keycloak's policies apply to the user rather than to the server.

## APISIX - No Access without an Access Token

The gateway route for `/mcp` runs the `openid-connect` plugin in `bearer_only` mode.

#### :three: Request:

```console
curl -iX POST 'http://localhost:1030/mcp' \
-H 'Content-Type: application/json' \
-H 'Accept: application/json, text/event-stream' \
--data-raw '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

#### Response:

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="farm-management"

{"message":"Missing authorization in request"}
```

## Keycloak - Obtaining an Access Token

#### :four: Request:

```console
curl -X POST 'http://localhost:3005/realms/farm-management/protocol/openid-connect/token' \
-H 'Content-Type: application/x-www-form-urlencoded' \
--data 'username=bob&password=test&grant_type=password&client_id=ngsi-ld-farm&client_secret=1234&scope=openid profile email'
```

#### Response:

```json
{
    "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6...",
    "expires_in": 300,
    "token_type": "Bearer",
    "scope": "openid profile email"
}
```

The token carries the user's realm roles in its `realm_access.roles` claim. Both APISIX and the MCP server verify it
against the realm's JWKS, so neither calls back to Keycloak per request.

> **Note:** Keycloak stamps the `iss` claim from its configured frontend hostname, which is why the compose file sets
> `KC_HOSTNAME=localhost`. Without it, a token fetched on `localhost:3005` carries an issuer that a verifier expecting
> `keycloak:8080` rejects as invalid. `KC_HOSTNAME_STRICT_BACKCHANNEL=false` leaves the endpoints that services call
> server-to-server resolving over the Docker network.

## Dynamic Discovery of the Authorization Server

A client holding no token needs to find out where to get one. Rather than hardcoding the realm URL, the MCP server
publishes [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html) protected-resource metadata, and the gateway leaves
that route unauthenticated - requiring a token to discover how to obtain a token would be a closed loop.

#### :five: Request:

```console
curl -X GET 'http://localhost:1030/.well-known/oauth-protected-resource'
```

#### Response:

```json
{
    "resource": "http://localhost:1030/mcp",
    "authorization_servers": ["http://localhost:3005/realms/farm-management"],
    "bearer_methods_supported": ["header"],
    "scopes_supported": ["openid", "profile", "email"]
}
```

## Role-Based Access to Tools

APISIX validates the signature, issuer and expiry, but it cannot tell one MCP call from another: every tool call is a
`POST /mcp`, so there is no URL or method to write a policy against. Fine-grained control therefore happens inside the
MCP server, which reads the roles out of the token it has just verified.

#### :six: Request:

```console
curl -X POST 'http://localhost:1030/mcp' \
-H 'Content-Type: application/json' \
-H 'Accept: application/json, text/event-stream' \
-H 'Authorization: Bearer <bobs_access_token>' \
--data-raw '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Bob holds `farm-manager`, so all nine tools are returned. Repeating the call with Mallory's token returns five:

#### Response:

```json
{
    "result": {
        "tools": [
            { "name": "discover_context_meta_data" },
            { "name": "get_entity" },
            { "name": "query_entities" },
            { "name": "geoquery_entities" },
            { "name": "get_entity_history" }
        ]
    }
}
```

`create_entity`, `upsert_attribute`, `delete_attribute` and `delete_entity` are absent rather than refused. This matters
more than refusing would: an agent cannot be talked into using a tool it has never been told about.

A role need not be all or nothing. `WRITE_ROLES` lists the roles that may write, and a role written as
`role:TypeA|TypeB` may write only those types:

```yaml
- WRITE_ROLES=farm-manager,livestock-supervisor:Animal|Water|FillingLevelSensor
```

Carol therefore sees all four write tools, but each one checks the type of the entity before it touches the broker. The
type is read from the broker rather than taken from the tool arguments, so asking Carol's agent to rename the Wheatfield
(`urn:ngsi-ld:AgriParcel:001`) fails with a `403` of category `auth`, while updating a cow succeeds.

## Enforcement at the Context Broker

Hiding the tools is the first line, not the only one. The MCP server holds no broker credentials of its own for user
traffic - it forwards the caller's token onward, and APISIX applies Keycloak
[UMA](https://www.keycloak.org/docs/latest/authorization_services/) policies to the entity endpoints using
`http_method_as_scope`, so a read is a `GET` scope and a create a `POST`.

#### :seven: Request:

```console
curl -iX POST 'http://localhost:1030/orion/ngsi-ld/v1/entities' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <jennys_access_token>' \
-H 'Link: <http://context/user-context.jsonld>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"' \
--data-raw '{"id":"urn:ngsi-ld:Animal:cow099","type":"Animal"}'
```

#### Response:

```text
HTTP/1.1 403 Forbidden
```

Jenny is a `read-only-consultant`: policy grants her `GET`, and nothing grants her `POST`. Through a tool call the same
refusal reaches the agent as a failure of category `auth`, which its instructions tell it to report rather than retry.

## Logging In to the Chat-bot

With security on, `http://localhost:3006` shows a sign-in screen rather than the chat. The chat bot never sees a
password - it redirects to Keycloak, which renders its own login page, and receives an authorization code back.

![Chat-bot sign-in screen](https://fiware.github.io/tutorials.MCP-Server/img/chat-bot-login.png)

From then on the bot opens its own MCP connection carrying that user's token, so two people using the same chat bot get
two connections and two different sets of tools. Sign in as `bob` and ask it to record a treatment; it works. Sign out,
sign in as `mallory`, and ask the same thing. The agent reads what it can and reports that it has no way to record
anything - not a refusal it invented, but the honest consequence of the tool list it was given.

# License

[MIT](LICENSE) © 2020-2026 FIWARE Foundation e.V.
