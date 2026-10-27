# dx — realtime (ws / sse / resume)

SSE and WebSocket already ship in all SDKs (H8). v1 fixes typing + reconnect parity and ships a reference resume server. honey does not emit `x-realtime`; the consumer opts in via `.meta({})`.

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| WS route handler: `ws(app, path).handler({ … })` | yes (for WS) | — | handles an upgraded WebSocket; 101 performed by the adapter; `ws` is imported from `@lovrozagar/honey/ws`, not an app method (bit 19 i2) | the upgrade path is matched by a separate finalize plan | `routing/ws-builder.test.ts`, `integration/realtime.test.ts` |
| WS `.input()` / `.meta()` / `.errors()` / `.origins()` / `.use()` | no | — | typed WS message input, meta, errors, origin policy, middleware | an open `origins` policy accepts any origin — set it | `routing/ws-builder.test.ts` |
| WS origin policy | no | — | allow/deny upgrade by `Origin` (`ws-origin.ts`) | a missing policy is a cross-site WS risk [F1] | `ws/origin.test.ts` |
| `ctx.res.sse(...)` | — | — | `text/event-stream`; v1 types the declared event schema [H8] | the declared event schema must reach the SDK types | `response/sse.test.ts` |
| `.meta({ extensions: { "x-realtime": true } })` | no | off | opts the operation into the resume protocol | consumer-driven; honey never sets it itself | `integration/realtime.test.ts` |
| `Last-Event-ID` resume | — | — | resume a dropped SSE/WS stream from the last id | reconnect parity is uniform across all SDKs in v1 | `realtime/server.test.ts`, `integration/realtime.test.ts` |
| reference resume server | — | ships | the conformance target the SDK reconnect tests run against | kept in `tests/` so reconnect is actually exercised | `realtime/reference-server.test.ts` |
| realtime bus / publisher (`RealtimeBus`, `RealtimePublisher`) | no | — | server-side pub/sub backing the resume stream | at-least-once vs at-most-once is the app's choice | `realtime/bus.test.ts` |
| runtimes | — | node / bun / cf | per-runtime WS adapters (`ws/{node,bun,cloudflare}.ts`) | Deno adapter removed (H15) | `ws/node.test.ts` |

## The SDK side (bit 19 k1)

- **Auth:** a realtime connection's SSE and long-poll dials run the client's hooks and refresh once per open on a 401
  through `onAuthExpired`; its WebSocket dial runs no hook and no refresh, so a 401 there is the dial's error (every
  SDK alike; `emit/shared/runtime-docs.test.ts` pins the sentence in each runtime).
- **Keepalive and cap in the browser:** the platform `WebSocket` exposes no ping and no message cap, so a TypeScript
  socket has neither; the resumable connection keeps its own keepalive (`realtime-connection.ts`).
- **Java's realtime loop:** its open is bounded at 30 s (`ApiTimeoutException`); an interrupt drops the transport and
  reconnects from the cursor; `close()` ends it (`CancellationException` to a waiting read).
- **Ending and freeing:** see dx/client.md's per-target table.

