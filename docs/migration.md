# Migrating from 0.7 to 1.0

Each deliberate break from v0 0.7.x, with what you wrote before and what you write now. A "before" block is v0 and
is shown as it was; an "after" block is v1 and is compiled by the docs' tests. The SDK examples call a client
generated from a small example API (`Kitchen`); yours is named after your document.

## Code generation moved to `@lovrozagar/honey-codegen`

The `@lovrozagar/honey/codegen` export is gone. Its SDK, CLI and MCP generators are the `honey-codegen generate` bin
and its module API. Only v0's document-level `mergeSpecs` and `scopeSpec` are removed: several honey services still
combine through `mergeTree` over their route trees, and one merged tree still emits several documents, each with its
own `securitySchemes` and `filterRoutes`. Merging a third-party document is planned after 1.0.

```ts v0
import { generateSdk, mergeSpecs } from "@lovrozagar/honey/codegen"
```

```sh
honey-codegen generate --spec openapi.json --target ts --out ./sdk
```

## `--app` takes a module that exports the app

`honey-codegen generate --app` and `honey generate --app` import a module that exports the app and binds nothing.
v0's no-bind flag has no counterpart, because v1 never serves on import.

```ts v0
const app = honey()
app.serve({ port: 3000 })
```

```ts
import { honey } from "@lovrozagar/honey"

export const app = honey()
app.get("/health").handler((ctx) => ctx.res.text("ok", "up"))
```

## The TS SDK's realtime `token?` and `onAuthExpired?` are gone

Neither was ever read. A connection's `headers` may be a function read on every dial, and the client's
`onAuthExpired` is the one refresh hook.

```ts v0
client.chat.connect({ token: "t", onAuthExpired: () => refresh() })
```

```ts sdk
import { Kitchen } from "./kitchen"

const refresh = async () => "new-token"
const client = new Kitchen({ baseURL: "https://api.example.com", onAuthExpired: refresh })
```

## The TS SDK reads the spec's security scheme for its auth header

As every other SDK does: an `apiKey` scheme's header with no prefix, bearer as `Authorization: Bearer`. A caller's
`authHeaderName` alone no longer implies `Bearer `; set `authHeaderPrefix` to keep one.

```ts v0
new Client({ authHeaderName: "x-token" })
```

```ts sdk
import { Kitchen } from "./kitchen"

const client = new Kitchen({
	baseURL: "https://api.example.com",
	authHeaderName: "x-token",
	authHeaderPrefix: "Bearer ",
})
```

## WebSocket keepalive is on by default

Every SDK pings every 20 s and ends the connection when a pong does not come within the interval. Go
`Config.WSKeepalive` and `TransportOpts.KeepAlive`, Rust `ws_keepalive` and Python `ws_keepalive` set it. The bare
TS `createResumableConnection`'s `keepaliveInterval` defaults to 20 s (0 turns it off), while the SDK-built realtime
connection defaults to 0, because a browser WebSocket has no control ping. `keepaliveOf` is exported.

```ts v0
createResumableConnection({ transports, keepaliveInterval: 20_000 })
```

```ts sdk
import { createResumableConnection, type TransportAdapter } from "./kitchen"

declare const transports: TransportAdapter[]
const connection = createResumableConnection({
	url: "https://api.example.com/prices",
	transports,
	keepaliveInterval: 0,
})
```

## A realtime open is terminal when every transport refused it

An open ends when every transport refused it (400, 401 after the one refresh, 403, 404, 405, 410, 422), with the most
specific refusal as the error. A transient failure (408, 429, 5xx, a transport error) still backs off and retries, and
a refused WebSocket upgrade still falls through to SSE and long-poll.

```ts v0
connection.on("error", () => connection.reconnect())
```

```ts sdk
import { RealtimeConnectError, type ResumableConnection } from "./kitchen"

declare const connection: ResumableConnection
try {
	for await (const message of connection) console.log(message)
} catch (error) {
	if (error instanceof RealtimeConnectError) console.error("refused by every transport", error.message)
}
```

## A 401 on any realtime transport refreshes once per open

The token refreshes once per open through the client's one auth hook, and the chain restarts from its first
transport. Rust adapters gain `Transport::refresh`, Python adapters `refresh()`. The TS `RealtimeAuthError` export is
removed: it was never thrown.

```ts v0
import { RealtimeAuthError } from "./sdk"
```

```ts sdk
import { Kitchen } from "./kitchen"

const client = new Kitchen({
	baseURL: "https://api.example.com",
	onAuthExpired: async () => (await fetch("/session/refresh")).text(),
})
```

## A TS realtime operation returns a `ResumableConnection<T>`

The SDK builds it over WebSocket, then SSE, then long-poll, whatever the operation's ws or sse extension. A
non-realtime ws or sse operation still returns its socket or async iterable. The TS WebSocket dial carries no
credential (the platform cannot send headers), so a server that requires auth on the upgrade gets TS clients on SSE
or long-poll; tokens never go in the URL.

```ts v0
const socket = client.prices.subscribe()
```

```ts sdk
import type { ResumableConnection } from "./kitchen"

type Price = { eur: number }
declare const prices: ResumableConnection<Price>
for await (const price of prices) console.log(price.eur)
```

## `ResumableConnection` is generic, its `send` returns a promise

`ResumableConnection<T>` is generic over its payload, `send` returns `Promise<void>`, and `RealtimeOptions` is
exported.

```ts v0
connection.send({ text: "hi" })
```

```ts sdk
import type { RealtimeOptions, ResumableConnection } from "./kitchen"

declare const connection: ResumableConnection<{ text: string }>
const options: RealtimeOptions = {}
await connection.send({ text: "hi" })
void options
```

## `lastId: number` becomes `lastEventId: string`

`ResumableConnectionOpts.lastId` becomes `lastEventId`, a string, matching SSE ids and every other SDK's cursor.

```ts v0
createResumableConnection({ transports, lastId: 41 })
```

```ts sdk
import { createResumableConnection, type TransportAdapter } from "./kitchen"

declare const transports: TransportAdapter[]
createResumableConnection({ url: "https://api.example.com/prices", transports, lastEventId: "41" })
```

## A realtime connection sends raw text

Every SDK sends raw text: Rust gains `send_text`, TS `ResumableConnection.sendText` (a text frame on WebSocket, a
`text/plain` POST over SSE and long-poll). `send` still JSON-encodes.

```ts v0
connection.send(JSON.stringify("plain words"))
```

```ts sdk
import type { ResumableConnection } from "./kitchen"

declare const connection: ResumableConnection
await connection.sendText("plain words")
```

## A TS network failure is `APIConnectionError`

A network failure is `APIConnectionError`, its `cause` the platform's error, not a raw `TypeError`, and safe mode
throws it like every SDK, since no answer exists. An abort or a timeout keeps its own error.

```ts v0
try {
	await client.health()
} catch (error) {
	if (error instanceof TypeError) retry()
}
```

```ts sdk
import { APIConnectionError, Kitchen } from "./kitchen"

const client = new Kitchen({ baseURL: "https://api.example.com" })
try {
	await client.getApiHealth()
} catch (error) {
	if (error instanceof APIConnectionError) console.error("unreachable", error.cause)
}
```

## The MCP server's headers and redirect policy come from the environment

The generated MCP server takes `$<PREFIX>_HEADERS` (a JSON object of string values, validated at start and scrubbed
from every result) and `$<PREFIX>_REDIRECT=same-origin|follow` (default `same-origin`).

```sh v0
SHOP_MCP_TOKEN=t ./shop-mcp
```

```sh
SHOP_HEADERS='{"x-tenant":"acme"}' SHOP_REDIRECT=same-origin ./shop-mcp
```

## A WebSocket route's `.meta()` refuses keys it cannot honor

`deprecated`, `security`, `invalidate` and `mcp` are refused at the type level on a WebSocket route, where the build
dropped them silently.

```ts v0
app.ws("/feed").meta({ deprecated: true })
```

```ts
import { honey } from "@lovrozagar/honey"
import { ws } from "@lovrozagar/honey/ws"

const app = honey()
ws(app, "/feed")
	.meta({ summary: "Live feed" })
	.handler({ onOpen: (_ctx, socket) => socket.send("hello") })
```

## SDK error messages read `HTTP <status>: <message>`

Every target formats them alike, `HTTP <status>: <message>` or `HTTP <status>` with no message: Go and Rust drop the
reason phrase they printed (`404 Not Found: <message>`), and TS adds the prefix. Match the typed error and its
status, never the text.

```ts v0
if (String(error).startsWith("Not Found")) showMissing()
```

```ts sdk
import { Kitchen, NotFoundError } from "./kitchen"

const client = new Kitchen({ baseURL: "https://api.example.com", throwOnError: true })
try {
	await client.getApiV1OrganizationsByOrgId({ params: { orgId: "org-404" } })
} catch (error) {
	if (error instanceof NotFoundError) console.error("no such organization")
}
```

## The TS SDK's SSE caps are UTF-8 bytes

`sseMaxBufferChars` is replaced by `sseMaxLineBytes` (1 MiB) and `sseMaxEventBytes` (8 MiB), measured in UTF-8 bytes
like every other SDK.

```ts v0
new Client({ sseMaxBufferChars: 1_000_000 })
```

```ts sdk
import { Kitchen } from "./kitchen"

const client = new Kitchen({ baseURL: "https://api.example.com", sseMaxLineBytes: 1 << 20, sseMaxEventBytes: 8 << 20 })
```

## The TS SDK speaks the HTTP version its `fetch` negotiates

Node 26 may use HTTP/2, and browsers choose their own; every other SDK is pinned to HTTP/1.1. To control it, pass
your own `fetch`.

```text v0
every request over HTTP/1.1
```

```ts sdk
import { Kitchen } from "./kitchen"

const client = new Kitchen({ baseURL: "https://api.example.com", fetch: (input, init) => fetch(input, init) })
```

## The plugin's `codegen.sdk` and `codegen.cli` are removed

The plugin writes the app's own artifacts (the route tree, the manifest, the OpenAPI JSON and YAML, the types), and
`honey-codegen generate --app <module>` writes the SDKs, the CLI and MCP. Passing either key is an error naming that
command.

```ts v0
honey({ app: "src/app.ts", codegen: { sdk: { out: "sdk" } } })
```

```ts
import { honey } from "@lovrozagar/honey/plugin"

export const plugin = honey({ app: "src/app.ts" })
```

## A gateway config works unchanged

`app` plus `codegen.mergeTree` (a gateway over several services) is unchanged. The tree written is the services'
merged routes plus the gateway's own, and the documents, manifest and types come from the served `app` with the
services' schemas. A first run bootstraps the merged tree.

```ts v0
honey({ app: "src/gateway.ts", codegen: { mergeTree: { users: "../users", billing: "../billing" } } })
```

```ts
import { honey } from "@lovrozagar/honey/plugin"

export const plugin = honey({ app: "src/gateway.ts", codegen: { mergeTree: "src/merge.ts" } })
```

## A gateway with its own routes exports its app built without its tree

A gateway that adds a route its generated tree lacks cannot be imported over that tree: export the gateway's app,
built without its tree, from the merge entry as `app`, and generation builds the tree from it before importing the
served app. v0's codegen-process tolerance has no v1 counterpart; the error names both fixes.

```ts v0
export default createGateway({ routeTree })
```

```ts
import { honey } from "@lovrozagar/honey"

/* the merge entry: the gateway's own routes, without the generated tree it would otherwise load */
export const app = honey()
app.get("/status").handler((ctx) => ctx.res.json("ok", { up: true }))
```

## `honey()` transforms no module

v0 injected feature entries into the build. Each feature is now a plain import, so a bundle holds only what you use.

```ts v0
app.realtime("/rt", handler)
```

```ts
import { honey } from "@lovrozagar/honey"
import { realtime } from "@lovrozagar/honey/realtime"

const app = honey()
realtime(app, "/rt", { handler: (_ctx, conn) => conn.send({ hello: true }) })
```

## `trust` and `trustProxy` are cut

`ctx.ip` is the platform's peer: `CF-Connecting-IP` on Workers, the socket on Node and Bun, never an
`X-Forwarded-*` value. Behind your own proxy, read the header your proxy sets in your own code.

```ts v0
import { trustProxy } from "@lovrozagar/honey/trust"
app.use(trustProxy(1))
```

```ts
import { honey } from "@lovrozagar/honey"

const app = honey()
app.get("/whoami").handler((ctx) => {
	/* behind your own proxy only: the header your proxy sets, read by you */
	const client = ctx.req.headers.get("x-real-ip") ?? ctx.ip
	return ctx.res.json("ok", { client })
})
```

## `@lovrozagar/honey/openapi/spec` is removed

v0's `spec()` handler is `serveOpenApi` from `@lovrozagar/honey/openapi`, which mounts the JSON and YAML documents (and
a docs page with `docs`) rather than returning a handler.

```ts v0
import { spec } from "@lovrozagar/honey/openapi/spec"
app.get("/openapi.json").handler(spec(app))
```

```ts
import { honey } from "@lovrozagar/honey"
import { serveOpenApi } from "@lovrozagar/honey/openapi"

const app = honey()
serveOpenApi(app, { title: "Shop", version: "1.0.0", docs: "scalar" })
```

## `app.ws(path)` becomes `ws(app, path)`

`import { ws } from "@lovrozagar/honey/ws"`, the same shape as `realtime(app, path)`. It takes any handle `.ws()` was
a method of (the app, a `.basePath()` handle, a chain) and types the route exactly as before. An app that opens no
socket then bundles no WebSocket route code, about 1.1 KB gzipped.

```ts v0
app.ws("/echo").handler({ onMessage: (_ctx, socket, data) => socket.send(data) })
```

```ts
import { honey } from "@lovrozagar/honey"
import { ws } from "@lovrozagar/honey/ws"

const app = honey()
ws(app, "/echo").handler({ onMessage: (_ctx, socket, data) => socket.send(data) })
```

## `testClient` moved, and `transport: "node"` is `transport: "serve"`

`testClient` comes from `@lovrozagar/honey/testing`. `transport: "serve"` serves the app with `serve(app)` on a free
port through the runtime's own adapter (Node's on Node, Bun's on Bun), so it is no longer Node-only.

```ts v0
const client = testClient(app, { transport: "node" })
```

```ts
import { honey } from "@lovrozagar/honey"
import { testClient } from "@lovrozagar/honey/testing"

const app = honey()
const client = testClient(app, { env: {}, transport: "serve" })
await client.close()
```

## `app.serve(...)` is removed

Import `serve` from `@lovrozagar/honey/serve` and pass the app. On Cloudflare Workers, export the app itself.

```ts v0
app.serve({ port: 3000 })
```

```ts
import { honey } from "@lovrozagar/honey"
import { serve } from "@lovrozagar/honey/serve"

const app = honey()
const server = await serve(app, { hostname: "0.0.0.0", port: 3000 })
await server.close()
```

## Installed packages run their compiled `dist/`

An installed `@lovrozagar/honey` and `@lovrozagar/honey-codegen` run their compiled `dist/` on every runtime, Bun
included; v0's `bun` export condition to the TypeScript source is gone. Nothing to change in your code; a tool that
read honey's source from `node_modules` reads `dist/` now.

```text v0
bun resolved "@lovrozagar/honey" to src/index.ts
```

```sh
bun add @lovrozagar/honey @lovrozagar/honey-codegen
```
