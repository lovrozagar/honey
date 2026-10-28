# The generated MCP server

`honey-codegen generate --target mcp` writes a Model Context Protocol server: one tool per operation, its
input schema from the operation's parameters and body, and structured output for agents. Read-only operations are
annotated as such. The server takes its base URL, extra headers (`$<PREFIX>_HEADERS`) and its redirect policy
(`$<PREFIX>_REDIRECT`) from the environment. A multipart operation is a tool too: each part is an argument, a file
part a file argument (see [File arguments](#file-arguments)). The server speaks stdio by default and Streamable HTTP
with `--http` (see [Over HTTP](#over-http)).

## Example

```sh
honey-codegen generate --spec openapi.json --target mcp --out ./mcp
```

## Reference

| Value                                             | Default                 | What it does                                                                                                                      | Watch for                                                         |
| ------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `.meta({ extensions: { "x-mcp": true } })` gating | required to emit a tool | only operations marked `x-mcp` become tools                                                                                       | an unmarked operation is not exposed                              |
| tool `inputSchema`                                | from the operation      | typed tool input from the request schema                                                                                          | derived from the IR, not hand-written (emitted inside `tools.ts`) |
| tool `outputSchema` + `structuredContent`         | emitted                 | typed structured result from the response schema                                                                                  | replaces text-only results; still includes a text fallback        |
| tool annotations                                  | from method/meta        | `readOnly` (GET), `idempotent`, `destructive` hints                                                                               | derived from HTTP method + meta, not guessed                      |
| binary / image result                             | —                       | an image or audio body is its content type's MCP content; other bytes an embedded resource; past 1 MiB `isError`, the status kept | base64/blob per the MCP content type                              |
| error result                                      | `{ isError: true }`     | failures surface as tool errors                                                                                                   | the error key maps to the typed error model                       |
| token budget                                      | enforced                | each tool schema is measured against the per-operation threshold                                                                  | an oversized tool schema fails the token gate                     |
| file argument                                     | inline or `{path}`      | a multipart file part, sent as `multipart/form-data` with the form's text parts                                                   | a path is read only over stdio, inside `$<PREFIX>_FILE_ROOT`      |
| `--http`                                          | stdio                   | Streamable HTTP at `/mcp` on `127.0.0.1:8000`, a bearer token required                                                            | the token is `$<PREFIX>_MCP_TOKEN`; it never reaches the API      |

## File arguments

A multipart operation marked `x-mcp` is a tool. Each text part is an argument with the part's own schema; each file
part is a file argument, or a list of them when the part is an array. The form always goes as `multipart/form-data`,
with or without a file in it.

A file argument takes one of these values:

- **Inline**, as the provisional file-uploads extension (`io.modelcontextprotocol/files`, its draft at PR head
  `6101d34`) has it: `{ id, mimeType, size, digest: { algorithm: "sha-256", value }, name?, data }`. `data` is standard
  base64 with its padding: no whitespace, no `data:` prefix, no base64url. It must decode to exactly `size` bytes whose
  SHA-256, base64url without padding, is `digest.value`. All inline files of one call together are at most
  `$<PREFIX>_MAX_INLINE_BYTES` decoded (1 MiB by default). Every server with a file argument advertises the extension
  in both eras, `capabilities.extensions["io.modelcontextprotocol/files"] = { maxInlineBytes }`. A value without
  `data` asks for an upload, which only a mount with [uploads](#uploads) serves; elsewhere it's refused as a tool error.
- **`{ path }`**, read by the server from its own disk, over stdio only:
  - The path resolves against `$<PREFIX>_FILE_ROOT`, the server's working directory at start by default. A root that
    is no directory stops the server at start.
  - The path is resolved through every symlink and must stay under the resolved root. A `..` chain, an absolute path
    elsewhere, or a link out of the root is refused.
  - The file is opened without following a last link and without waiting on a FIFO. It is read only if its descriptor
    is a regular file and the very file the path resolved to: a swap between the check and the open is refused.
  - It is at most `$<PREFIX>_MAX_FILE_BYTES` (50 MiB by default) and is read to exactly the size it had when opened.
    A file that grows while it is read is refused, as is a `/proc` file whose size is not its length.
  - A refusal names the rule broken, never the path.

**A hard link inside the root to a file outside it cannot be told apart from a file of the root.** It is the same
file to the kernel, so no path check sees it. Keep the root narrow and let no one who should not read a file link it
there.

- **`{ url }`**, an https URL the app fetches: only on a mount with [files from URLs](#files-from-urls). A mounted
  tool shows the inline value and, with `urlFiles`, the URL value; it never shows a path.

Each file argument costs a tool 98 tokens of schema (FileInput and path); a mounted tool's costs 97 with the URL value
and 64 without it. The file-uploads extension is a draft that may still change; honey tracks it at every phase of bit 21.

## Over HTTP

`<name>-mcp --http` serves Streamable HTTP at `/mcp`, for MCP 2026-07-28 and for 2025-11-25 down to 2025-03-26 on one
endpoint. It keeps no session: each POST is answered on its own, and no `Mcp-Session-Id` is ever sent.

```sh
SHOP_MCP_TOKEN=$(openssl rand -hex 32) SHOP_API_KEY=… shop-mcp --http --port 8000
```

- **`--host`** is `127.0.0.1` by default. `localhost` and `::1` are loopback too. Any other address needs `--expose`.
- **`--port`** is `8000` by default; `0` lets the system pick one. The server says where it listens on stderr:
  `shop MCP server on http://127.0.0.1:8000/mcp`.
- **The token.** Every request sends `$<PREFIX>_MCP_TOKEN` as `Authorization: Bearer <token>`, else it gets 401. The
  server compares the token in constant time. Without the variable set, the server refuses to start unless
  `--no-auth` is given. `--no-auth` with the variable set, or with `--expose`, refuses to start too.
- **The API's own key.** Tool calls reach the API with `$<PREFIX>_API_KEY`, exactly as over stdio. The token is never
  sent to the API, and a result that holds it has it scrubbed.
- **DNS rebinding.** The server answers only a `Host` of `127.0.0.1`, `localhost` or `[::1]` with its own port: any
  other gets 421 (Misdirected Request). `--expose` drops this check, for a non-loopback bind or a reverse proxy that
  sends its own host name; the token is then the guard.
- **Origin.** A browser's `Origin` must be the server's own, else 403. `$<PREFIX>_MCP_ORIGINS` lists others,
  comma-separated, each compared exactly (`https://app.example`). A request with no `Origin` is served.
- **Limits.** POST only (405 otherwise). `Accept` must name `application/json` and `text/event-stream` (406), and the
  body must be JSON (415). A body is read at most `$<PREFIX>_MAX_BODY_BYTES` (4 MiB by default) as it arrives, whatever
  `Content-Length` says (413).
- **Files.** Only inline file values work over HTTP. A `{ path }` is a tool error: a remote caller never makes the server
  read its own disk.
- **Answers.** An answer is JSON, or an event stream once a call reports progress. Under 2026-07-28, closing the request
  or its stream cancels the call; under 2025-11-25 a disconnect is no cancel, as that revision says.

## Mounting in your app

An app can serve its own tools itself, at a path of its own, over Streamable HTTP: the same tools, each call
dispatched in process through the app, so its middleware, limits and every route's own auth run again.

| Value                               | What it is                                                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codegen.mcp`                       | the `honey()` plugin output that writes the mounted handler: the entry `src/_gen/mcp.gen.ts` (exporting `mcpHandler`) plus its companion directory `src/_gen/mcp/`, the runtime and the API's TS SDK |
| `mcp(app, path, handler, options?)` | from `@lovrozagar/honey/mcp`: mounts the generated handler at `path`, POST only (GET and DELETE answer 405), under the app's basePath and middleware, auth before any dispatch                       |
| `authenticate(request, ctx)`        | required when any mounted tool's operation declares security, else `mcp()` throws at mount; it returns a boolean only, and `false` gets HTTP 401 with `WWW-Authenticate`                             |

The plugin writes the handler from the app's own routes marked `mcp: true`:

```ts
import { honey } from "@lovrozagar/honey/plugin"

export default { plugins: [honey({ app: "src/app.ts", codegen: { mcp: true } })] }
```

The app mounts it, checking the credential before any tool runs:

```ts
import { honey } from "@lovrozagar/honey"
import { type McpHandler, mcp } from "@lovrozagar/honey/mcp"

/* in the app: import { mcpHandler } from "./_gen/mcp.gen.ts" */
declare const mcpHandler: McpHandler

const app = honey()
mcp(app, "/mcp", mcpHandler, {
	authenticate: (request) => /^ApiKey \S+$/.test(request.headers.get("authorization") ?? ""),
})
```

- **Fail-closed, no exceptions.** When any tool's operation declares security, `mcp()` throws unless it is given an
  `authenticate` function. There is no option that skips it.
- **The credential.** Each tool call carries the MCP request's own credential headers, the ones the tools' security
  schemes name (`Authorization` for an http, OAuth or OpenID scheme, an API key's own header) and no other. The inner
  routes check it again; `authenticate`'s answer reaches them as nothing else.
- **An inner 401** (or a 403 for `insufficient_scope`) is the endpoint's HTTP answer with that challenge, never a
  tool result. Any other status stays the tool's result, its status in `_meta` `honey/status`.
- **Only the app's own origin.** A call that would leave the app's origin is refused before it is dispatched, so the
  credential never leaves the app.
- **Bodies** are capped at 4 MiB as they stream (`maxBodyBytes` changes it), after the app's own `bodyLimit`. A browser
  `Origin` other than the endpoint's own is refused 403 unless listed in `origins`.

### OAuth

The mounted endpoint can act as an OAuth 2.1 resource server, the role the MCP authorization spec gives a protected
server. honey serves the resource server's discovery half only: it never issues tokens and never checks them. You
bring the authorization server, and your own code (`authenticate` and each route) validates the token.

| Value                          | What it is                                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth(options)`               | from `@lovrozagar/honey/mcp/oauth`: the resource server, handed to `mcp()` as its `oauth` option, which then needs `authenticate`; an app that never imports it bundles none of it |
| `options.authorizationServers` | the issuer URLs of the authorization servers whose tokens the endpoint takes: at least one, each https (http only on a loopback host)                                              |
| `options.scopesSupported`      | the scopes a client asks for when a 401 names none; `offline_access` is refused                                                                                                    |
| `options.resource`             | the endpoint's public URL, for an app whose requests don't carry its public origin (behind a proxy); `mcp()` refuses one that isn't the endpoint's own path                        |
| `options.resourceName`         | the endpoint's name as a user sees it                                                                                                                                              |

```ts
import { honey } from "@lovrozagar/honey"
import { type McpHandler, mcp } from "@lovrozagar/honey/mcp"
import { oauth } from "@lovrozagar/honey/mcp/oauth"

/* in the app: import { mcpHandler } from "./_gen/mcp.gen.ts" */
declare const mcpHandler: McpHandler

/* the authorization server's Worker, bound as AUTH_SERVER: @cloudflare/workers-oauth-provider's validateToken */
type Env = {
	readonly AUTH_SERVER: { validateToken(resource: string, token: string): Promise<{ scope: string[] } | null> }
}

const ENDPOINT = "https://mcp.example.com/mcp"
const bearer = (request: Request) => /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? ""
const refused = (status: number, challenge: string) =>
	new Response(null, { headers: { "www-authenticate": challenge }, status })

const app = honey<Env>()
app
	.post("/orders")
	.meta({ mcp: true, security: [{ oauth: ["mcp:write"] }] })
	.handler(async (ctx) => {
		/* the route checks the token again, for the endpoint as its audience, and names every scope it needs */
		const granted = await ctx.env.AUTH_SERVER.validateToken(ENDPOINT, bearer(ctx.req))
		if (granted === null) return ctx.res.raw(refused(401, 'Bearer error="invalid_token"'))
		if (!granted.scope.includes("mcp:write"))
			return ctx.res.raw(refused(403, 'Bearer error="insufficient_scope", scope="mcp:read mcp:write"'))
		return ctx.res.json("created", { id: "o-1" })
	})

mcp(app, "/mcp", mcpHandler, {
	authenticate: async (request, ctx) => (await ctx.env.AUTH_SERVER.validateToken(ENDPOINT, bearer(request))) !== null,
	oauth: oauth({
		authorizationServers: ["https://auth.example.com"],
		resource: ENDPOINT,
		resourceName: "Example",
		scopesSupported: ["mcp:read"],
	}),
})
```

What the endpoint then serves:

- **Protected Resource Metadata** (RFC 9728) at the well-known URI with the endpoint's path inserted:
  `https://mcp.example.com/.well-known/oauth-protected-resource/mcp` for an endpoint at `/mcp`, the basePath and a
  stripped prefix included. It holds `resource` (the endpoint's URL, with no trailing slash),
  `authorization_servers`, `scopes_supported` when set, `bearer_methods_supported: ["header"]` and `resource_name`
  when set. It's a GET route under the same middleware as the endpoint, kept out of the OpenAPI documents and the
  tools; a middleware that refuses requests without a credential must let it through.
- **The root form** `/.well-known/oauth-protected-resource` is served only for an endpoint at `/`. Clients read the
  metadata URL off the 401 first, then try the path-inserted URI, and the root last; a root document for an endpoint
  at `/mcp` would have to name the origin itself as the resource, and RFC 9728 requires the document's `resource` to
  be the one its URL was built from.
- **401** when `authenticate` returns `false`, or a route refuses the token: `WWW-Authenticate: Bearer
  resource_metadata="…"`, with `error="invalid_token"` when the request carried a credential, and the route's own
  `scope` when its challenge names one. A 401 from `authenticate` names no scope: no operation is known before the
  body is read, so the client asks for `scopes_supported`.
- **403 step-up.** A route that answers 403 with `WWW-Authenticate: Bearer error="insufficient_scope",
  scope="mcp:read mcp:write"` makes the endpoint answer HTTP 403 with `Bearer error="insufficient_scope",
  scope="mcp:read mcp:write", resource_metadata="…"`, never a tool result. The client then authorizes again for the
  union of its scopes and the challenge's, and retries. The scopes come from the route's challenge alone, because only
  the route knows what it needs (it may depend on the arguments); name every scope the operation needs in one
  challenge. `offline_access` is dropped from it.
- **Without `oauth`** none of this is served: no metadata route, and the challenges stay as above. `oauth()` refuses
  its options when called; `mcp()` refuses a `resource` that isn't its endpoint, and `oauth` without `authenticate`.

**The token.** The client sends a token issued for the endpoint (its audience the endpoint's URL, RFC 8707). Each
tool call carries that token, in process, to the app's own routes: the same resource on the same origin, never
another service, and a call off the origin is refused before it leaves. So **your routes' validator must accept the
endpoint's URL as the token's audience**. `authenticate` checks the token on every request; the routes check it
again, with the scopes each needs.

**Behind a proxy.** The metadata's `resource` and the 401's `resource_metadata` use `resource`'s origin when it
is set, and the request's own origin otherwise. honey trusts no forwarded header, so set `resource` when the
app sees a different origin from the client's (TLS ended at a proxy, an internal host name). `mcp()` throws when it
names another path, or has a query, fragment or userinfo.

**Which clients need it.** ChatGPT connects only to a server with no auth or with OAuth, so an endpoint that needs a
credential needs `oauth` for it. Claude's custom connectors, Claude Code, Cursor, VS Code, Gemini CLI and Copilot Studio
take OAuth too, or a fixed `Authorization` header instead. Anthropic's Messages API connector sends only a
Bearer `authorization_token`.

**An authorization server on Workers.** `@cloudflare/workers-oauth-provider`'s `OAuthAuthorizationServer` can be the
authorization server, in its own Worker with your `/authorize` page, listing the endpoint's URL in its `resources`.
It exposes `validateToken(resource, token)` over a Service Binding, which both `authenticate` and the routes call
with the endpoint's URL. Its `OAuthResourceServer` is the half honey serves here, so the app doesn't use it. The
package's `examples/split-workers` shows the authorization server in full.

**The standalone server** (`--http`) has no OAuth: it serves one local user on a loopback port with its own token, and
calls the API with its own key, as the spec's advice for local servers says.

### Uploads

A file too big to inline goes out of band, through the file-uploads extension's upload flow (its draft at PR head
`6101d34`). The client sends the file's metadata without `data`; the endpoint answers with an
`io.modelcontextprotocol/files/upload` input request holding one upload target a file, an https URL under the
endpoint; the client PUTs the bytes there and retries the call with the same arguments. Only a 2026-07-28 request
that declares the extension in its `io.modelcontextprotocol/clientCapabilities` is asked to upload; any other gets a
tool error. No shipping client implements the extension yet.

| Value                        | What it is                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uploads(options)`           | from `@lovrozagar/honey/mcp/uploads`: the uploads, handed to `mcp()` as its `uploads` option; an app that never imports it bundles none of it             |
| `options.secret`             | the HMAC key upload tokens are signed with: at least 32 characters, your app's own secret (an env binding, never in source)                               |
| `options.store`              | an `UploadStore`, where uploads wait for the retry                                                                                                        |
| `options.ttlMs`              | how long a token works: 600000 (10 minutes) by default                                                                                                    |
| `options.maxBytes`           | the most bytes one file may declare: 52428800 (50 MiB) by default; a larger one is a tool error before any upload                                         |
| `options.origin`             | the endpoint's public origin, for an app whose requests don't carry it (behind a proxy); the request's own by default                                     |
| `UploadStore`                | `{ claim(id, expires), put(id, bytes, expires), take(id) }`, each sync or async; `claim` true for the first caller alone, `take` removing what it returns |
| `memoryUploadStore()`        | an in-memory `UploadStore` for one process: development, tests, a single Node or Bun server                                                               |
| `PUT <path>/uploads/<token>` | the upload route `mcp()` registers: 204 when the bytes are taken                                                                                          |

```ts
import { honey } from "@lovrozagar/honey"
import { type McpHandler, mcp } from "@lovrozagar/honey/mcp"
import { memoryUploadStore, uploads } from "@lovrozagar/honey/mcp/uploads"

/* in the app: import { mcpHandler } from "./_gen/mcp.gen.ts" */
declare const mcpHandler: McpHandler
declare const UPLOAD_SECRET: string

const app = honey()
mcp(app, "/mcp", mcpHandler, {
	authenticate: (request) => /^ApiKey \S+$/.test(request.headers.get("authorization") ?? ""),
	uploads: uploads({ secret: UPLOAD_SECRET, store: memoryUploadStore() }),
})
```

**The token is the upload's only authority.** The client sends no credential to the upload URL (the draft has
clients refuse `Authorization` and `Cookie` on it), so each URL carries a token: HMAC-SHA-256 under `secret` over a
random id, the expiry, the file's declared size and SHA-256, the principal and the call. The principal is
HMAC(`secret`, the credential headers the MCP request carried), keyed so a leaked URL or store gives no offline guess at
the credential; the call is HMAC(`secret`, the tool, every argument, the file's id). Nothing of either reaches your
routes, which get the same credential headers as any other call.

What the endpoint checks:

- **The PUT:** a token this app signed and not expired (else 403); the body counted as it streams, past the declared
  size 413 (Content-Length is never trusted), then exactly that size with that SHA-256 (else 400). Only then is the
  token claimed: the first PUT to claim it wins, any later one is 409. A refused PUT keeps and claims nothing, so a
  client may retry a failed transfer.
- **The retry:** each token checked again against the retry's own credential headers, tool and arguments; a mismatch,
  a forged or an expired token is JSON-RPC -32602. The bytes are taken from the store once and checked again, so a
  repeated retry finds nothing and the call never runs twice. A file the client reports `failed` is a tool error, and
  the tool doesn't run.
- **A credential that changes within the TTL** (a refreshed OAuth token, a rotated key) no longer matches, so the
  retry is refused and the client starts the call again and re-uploads.

**The store must claim atomically.** `claim` must return true to one caller alone, even when two PUTs race, and
`take` must hand the bytes to one caller alone. On Workers that means a Durable Object, or D1 (`INSERT … ON CONFLICT
DO NOTHING`, `DELETE … RETURNING`). **Workers KV cannot keep an upload one-shot**: it is eventually consistent, so two
claims can both succeed. `memoryUploadStore()` is one process's memory: on Workers, or behind more than one instance,
an upload PUT to one isolate is missing on another.

**The upload route** is a real route on the handle: its basePath and every middleware apply, `bodyLimit` included,
so set a limit that fits `maxBytes`. It's kept out of the OpenAPI documents and the tools. A middleware that refuses
requests without a credential must let `<path>/uploads/*` through. Answer the CORS preflight for it if browser clients
upload. The standalone `--http` server has no store and serves no uploads.

### Files from URLs

A mounted tool can take a file as `{ url }`, which the app fetches. It's off unless you pass `urlFiles`: without it
no tool shows the URL value and one is refused. Today's clients can use it for files too big to inline, since it's a
plain argument.

| Value               | What it is                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `urlFiles(options)` | from `@lovrozagar/honey/mcp/url-files`: the fetch, handed to `mcp()` as its `urlFiles` option; an app that never imports it bundles none of it     |
| `options.hosts`     | the hosts files come from: each exact (`files.example.com`, or with its port, `files.example.com:8443`), or `*.example.com` for the hosts under it |
| `options.maxBytes`  | the most bytes a file may hold: 52428800 (50 MiB) by default                                                                                       |
| `options.timeoutMs` | how long a fetch may take, headers and body: 30000 (30 s) by default                                                                               |
| `options.fetch`     | the fetch it runs, the platform's by default                                                                                                       |

```ts
import { honey } from "@lovrozagar/honey"
import { type McpHandler, mcp } from "@lovrozagar/honey/mcp"
import { urlFiles } from "@lovrozagar/honey/mcp/url-files"

/* in the app: import { mcpHandler } from "./_gen/mcp.gen.ts" */
declare const mcpHandler: McpHandler

const app = honey()
mcp(app, "/mcp", mcpHandler, { urlFiles: urlFiles({ hosts: ["files.example.com"] }) })
```

The guards:

- **The host** must be one the list names exactly; `files.example.com` matches neither `a.files.example.com` nor
  `evilfiles.example.com`. A `*.example.com` entry matches the hosts under `example.com`, never `example.com` itself.
  The list takes names only: `urlFiles()` refuses an IP address in any form the URL parser reads as one (`127.0.0.1`,
  `2130706433`, `0x7f.1`, `0177.0.0.1`, `[::ffff:127.0.0.1]`), so no private, loopback or link-local address is
  ever listed.
- **https only**, with no userinfo.
- **No redirect is followed**, to any host: a 3xx is refused, even back to a listed host. Presigned URLs don't
  redirect, and following only listed hosts would add a hop check for nothing.
- **The size** is counted as the body streams and refused past `maxBytes`; Content-Length is never trusted.
- **The time** covers the headers and the body; past `timeoutMs` the fetch is refused.
- **No credential** of the MCP request goes with the fetch.

**DNS is not resolved first.** The hosts are your own choice, so a listed host whose name points at a private address
is yours to not list. Checking the resolved address wouldn't close that either, since fetch resolves the name again (DNS
rebinding) and can't be pinned to an address on Workers or Bun. Workers' fetch reaches no private range at all.
