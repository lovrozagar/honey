# Proxying and gateways

`proxy({ destination })` from `@lovrozagar/honey/proxy` forwards a request and streams the answer back.
`destination(ctx, url, init)` returns the upstream `Response`: a `fetch()`, a Workers service binding, a Durable
Object stub. `requestHeaders` adds or overrides the forwarded headers, and `onResponse` edits the answer's headers
before it streams back. A network failure answers 502 and a timeout 504, and the current span's `traceparent` goes
along. A gateway documents each downstream route's own error keys.

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

## Reference

| Value                                          | Default                  | What it does                                                                                                                                                                                                                                                                                                                               | Watch for                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proxy({ destination, … })`                    | —                        | `destination(ctx, url, init)` returns the upstream `Response` — a `fetch()`, a service binding (`c.env.SVC.fetch(...)`) or a DO stub — and honey streams it back. `destination` is a **function**, not a `target: string`, because the gateway consumers (anyrow, lifeonomous) dispatch via service bindings, which a string can't express | `url` is a **single-leading-slash normalized path** (`ctx.path`, so `//`/`\`/`%2F`/`%5C` are already collapsed or 400'd) — that is the SSRF defense, not a host allowlist                                                                                                                      |
| `requestHeaders` (record or `(ctx) => record`) | pass-through             | add/override forwarded request headers                                                                                                                                                                                                                                                                                                     | the client's `Host`, `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, hop-by-hop (incl. `Connection`-named), `TE`, `Expect` never reach `destination`; honey sets `X-Forwarded-For`=`ctx.ip` (omitted when null), `-Proto`/`-Host` from the request URL; `CF-Connecting-IP` passes through untouched |
| `onResponse`                                   | pass-through             | mutate the upstream response (mutable `HoneyOutHeaders`: `set`/`delete`) before it streams back                                                                                                                                                                                                                                            | upstream error-key JSON surfaces byte-for-byte                                                                                                                                                                                                                                                 |
| `timeout` / `idleTimeout`                      | 60 s / —                 | per-request upstream deadline (header + idle); network failure → 502 `bad_gateway`, timeout → 504 `gateway_timeout`                                                                                                                                                                                                                        | a streaming upstream uses the idle timeout                                                                                                                                                                                                                                                     |
| traceparent forwarding                         | on when a span is active | forwards `traceparent` for the current span                                                                                                                                                                                                                                                                                                | the downstream continues the trace                                                                                                                                                                                                                                                             |
| downstream error keys                          | surfaced                 | the gateway documents each downstream route's own error keys                                                                                                                                                                                                                                                                               | —                                                                                                                                                                                                                                                                                              |
