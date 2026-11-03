# Proxying and gateways

`proxy({ destination })` from `@lovrozagar/honey/proxy` forwards a request and streams the answer back.
`destination(ctx, url, init)` returns the upstream `Response`: a `fetch()`, a Workers service binding, a Durable Object
stub. `requestHeaders` adds or overrides the forwarded headers, and `onResponse` edits the answer's headers before it
streams back. A network failure answers 502 `bad_gateway` and a timeout 504 `gateway_timeout`. `proxy()` declares both
keys on each route it handles, so the spec lists 502 and 504 there without an app-wide `.defaultErrors()`; like any
declared key, they leave `ctx.errors` on that route with only the declared keys. The current span's `traceparent` goes
along, as does the request id `requestId()` gave the request: a worker behind the gateway that sets
`requestId({ trustInbound })` for the gateway's hop keeps that id, so one request has one id in both logs. A gateway
documents each downstream route's own error keys.

## Example

```ts
import { honey } from "@lovrozagar/honey"
import { proxy } from "@lovrozagar/honey/proxy"

const app = honey()

app.all("/billing/*").handler(
	proxy({
		destination: (_ctx, url, init) => fetch(`https://billing.internal.example.com${url}`, init),
		requestHeaders: { "x-gateway": "edge" },
		timeout: 10_000,
	}),
)
```

## A gateway on its generated tree

A gateway serves the tree `honey generate` writes from `codegen.mergeTree`: its services' trees merged, plus the
gateway's own routes. Three files keep the app generation reads apart from the one the runtime serves:

- `gateway.app.ts` builds the gateway: its settings, middleware and own routes, with no tree.
- `route-tree.ts`, the `codegen.mergeTree` entry, exports the merged tree as `tree` and re-exports that app as `app`
  (`export { app } from "./gateway.app.ts"`), which generation reads the gateway's own routes from.
- `index.ts` serves `app.routeTree(routeTree)`: a new app with the same settings, middleware and routes, on the
  generated tree. The app it is called on stays treeless, so generation can import both files into one module graph.
  `routeTree()` can be called at any point, and a route registered on the new app binds to its leaf.

```ts
import { honey } from "@lovrozagar/honey"
import { proxy } from "@lovrozagar/honey/proxy"
import type { RouteTree } from "@lovrozagar/honey/tree"

/* gateway.app.ts */
export const app = honey()
app.get("/robots.txt").handler((ctx) => ctx.res.text("ok", "User-agent: *"))
app
	.all("/*")
	.handler(proxy({ destination: (_ctx, url, init) => fetch(`https://orders.internal.example.com${url}`, init) }))

/* index.ts: `import { routeTree } from "./_gen/routes.gen.ts"` */
declare const routeTree: RouteTree
export const served = app.routeTree(routeTree)
```

## Reference

| Value                                          | Default                  | What it does                                                                                                                                                                                                                                                                                                     | Watch for                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proxy({ destination, … })`                    | —                        | `destination(ctx, url, init)` returns the upstream `Response` — a `fetch()`, a service binding (`c.env.SVC.fetch(...)`) or a DO stub — and honey streams it back. `destination` is a **function**, not a `target: string`, because a gateway often dispatches via service bindings, which a string can't express | `url` is a **single-leading-slash normalized path** (`ctx.path`, so `//`/`\`/`%2F`/`%5C` are already collapsed or 400'd) — that is the SSRF defense, not a host allowlist                                                                                                                      |
| `requestHeaders` (record or `(ctx) => record`) | pass-through             | add/override forwarded request headers                                                                                                                                                                                                                                                                           | the client's `Host`, `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, hop-by-hop (incl. `Connection`-named), `TE`, `Expect` never reach `destination`; honey sets `X-Forwarded-For`=`ctx.ip` (omitted when null), `-Proto`/`-Host` from the request URL; `CF-Connecting-IP` passes through untouched |
| `onResponse`                                   | pass-through             | mutate the upstream response (mutable `HoneyOutHeaders`: `set`/`delete`) before it streams back                                                                                                                                                                                                                  | upstream error-key JSON surfaces byte-for-byte                                                                                                                                                                                                                                                 |
| `timeout` / `idleTimeout`                      | 60 s / —                 | per-request upstream deadline (header + idle); network failure → 502 `bad_gateway`, timeout → 504 `gateway_timeout`                                                                                                                                                                                              | a streaming upstream uses the idle timeout                                                                                                                                                                                                                                                     |
| traceparent forwarding                         | on when a span is active | forwards `traceparent` for the current span                                                                                                                                                                                                                                                                      | the downstream continues the trace                                                                                                                                                                                                                                                             |
| request id forwarding                          | on behind `requestId()`  | sends `ctx.requestId` under the `requestId` middleware's header, replacing any value the client sent                                                                                                                                                                                                             | the downstream reuses it only with `requestId({ trustInbound })`; `requestHeaders` can still remove it                                                                                                                                                                                         |
| downstream error keys                          | surfaced                 | the gateway documents each downstream route's own error keys                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                                                                                                              |
