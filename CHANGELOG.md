# Changelog

All notable changes to [`@lovrozagar/honey`](https://www.npmjs.com/package/@lovrozagar/honey) are documented in this file.

## Unreleased

### Security

- `ipRestrict` no longer trusts `CF-Connecting-IP` by default. Off Cloudflare any client could send it and pass an allow list, or omit it and skip a deny list. A request whose IP cannot be determined is now rejected with 403 for deny-only configs too.
- `ipRestrict({ trustProxy: true })` uses the rightmost `X-Forwarded-For` entry (the one your proxy appended) instead of the leftmost (client-controlled), and no longer reads `CF-Connecting-IP`.

### Migration

- `ipRestrict` needs an explicit IP source and throws at construction without one. On Cloudflare, add `trustCloudflare: true`. Behind one reverse proxy, use `trustProxy: true`. Otherwise pass `getIp`.

## 0.6.5 - 2026-10-02

### Fixed

- TypeScript SDK `onAuthExpired` retried streamed bodies (already consumed by the first attempt) and skipped `FormData`, so multipart uploads that hit an expired token failed instead of retrying. Now `FormData`, `Blob`, and string bodies retry once; `ReadableStream` bodies do not.

### Changed

- `onAuthExpired` receives `{ rejectedToken }`, the token the 401 rejected (read from the auth header). Callers can tell whether a concurrent request already refreshed and skip a second refresh. Hooks that ignore the argument keep working.

Regenerate SDKs after upgrading: `honey generate`.

## 0.6.3 - 2026-10-02

### Fixed

- Gateway OpenAPI documents lost every request and response body after 0.6.1. A gateway app serves its generated `routes.gen.ts`, and since 0.6.1 that tree carries no JSON Schema. `honey generate` now copies `iv`/`os` from the `codegen.mergeTree` source onto the loaded gateway app before it writes OpenAPI. The gateway's own `routes.gen.ts` still omits schemas, so the isolate stays the same size.

Merge live downstream apps in the `codegen.mergeTree` module with `app.toRouteTree()`. A downstream generated `routes.gen.ts` has no schemas to merge.

```ts
import { app as usersApp } from "@acme/users/app"
export const tree = mergeTree([usersApp.toRouteTree(), { worker: "users" }])
```

## 0.6.2 - 2026-10-02

### Fixed

- `ctx.res.raw(response)` copies status and headers into a new `Response`, and the body streams through unread. Responses from `fetch()`, `Fetcher.fetch` (Workers `ASSETS`, service bindings), `cache.match`, and `Response.redirect` have immutable headers. `requestId`, `secureHeaders`, `poweredBy`, and `serverTiming` set headers in place, so those routes returned 500. WebSocket upgrades (`101`) and responses Honey built pass through unchanged.

Drop any local `new Response(r.body, r)` wrapper around `ctx.res.raw`.

## 0.6.1 - 2026-10-02

### Changed

- Intern `H*` constants omit `iv` and `os`. JSON Schema no longer lives in `routes.gen.ts`. Match still uses the tree, `mt`, and `ek`. Runtime treats missing `iv`/`os` as no validation. Serve generate-time `openapi*.gen.json` as Worker static assets. `spec()` on an intern tree is metadata-only. `honey generate` still writes full OpenAPI documents from the live app.

Regenerate after upgrading: `honey generate`.

## 0.6.0 - 2026-10-02

### Changed

- `.proxy()` no longer aborts at 30s when `timeout` is omitted. Set `timeout` in milliseconds, or a `(ctx) => number`, to abort. `0` and non-positive values do not abort. WebSocket upgrades still skip the abort signal.

Gateways that need a deadline must set `timeout` on `.proxy()`.

## 0.5.3 - 2026-10-02

### Changed

- `spec()` from `@lovrozagar/honey/openapi/spec` walks the intern tree with JSON Schema already on the handlers. It does not import `codegen.ts`. Live Zod conversion stays behind `import "@lovrozagar/honey/openapi"` and `honey generate`. Gateway workers should import spec from `/openapi/spec` so the isolate does not eval the generator.
- Intern `H*` constants omit `ef: null`, `ov: null`, and `rp: ""`. Runtime treats missing `ef` as the global factory and missing `rp` as `""`.

Regenerate after upgrading: `honey generate`. Switch runtime `spec()` imports to `@lovrozagar/honey/openapi/spec`.

## 0.5.2 - 2026-10-02

### Changed

- Route-tree codegen emits interned static trees again. Cloudflare Worker Startup Time on a minified isolate that only loads the anyrow gateway `routes.gen.ts`: intern **18 ms**, packed `assembleRouteTree` **25 ms**, `JSON.parse` + inflate **39 ms**. Unique handlers and unique `ek` Sets stay. `MetaShape` and `RouteSelector` stay type-only.

Regenerate after upgrading: `honey generate`.

## 0.5.1 - 2026-10-01

### Changed

- Route-tree codegen emits a columnar `PackedRouteTable` object literal plus `assembleRouteTree` from `@lovrozagar/honey/tree`. Gzip/brotli of minified workers keep repeated JSON Schema text; named intern consts (`T*` / `J*` / `H*`) lost to the compressor. JSON Schema vocabulary keys in `iv`/`os` are packed (`type`→`t`) and expanded on inflate; property names, `enum`/`const`/`default` values stay intact. Type/format strings shrink (`string`→`s`, `email`→`e`). A `{oneOf:[schema,{type:"null"}]}` node flattens to `n1`. Input sources and output content types use short keys (`json`→`j`, `application/json`→`j`). Shared error keys live in `k`; identical meta keys collapse to `u` indices. Duplicate column values collapse to `{t,x}` when that JSON is smaller. `RouteSelector` is `typeof P[number]` from a type-only `declare const P`. `MetaShape` still uses literal and tuple types. Each inflated handler and `ek` Set is unique so `.routeTree()` patches cannot cross-wire routes.

Regenerate after upgrading: `honey generate`.

## 0.5.0 - 2026-10-01

### Added

- Route-tree codegen interns shared values in `routes.gen.ts`. Identical JSON Schema subtrees, meta objects, selectors, and error-key arrays are emitted once (`T*` / `U*` / `A*` / `J*` / `I*` / `O*` / `M*` / `P*`) and referenced. Handler objects and error-key `Set`s stay unique so `.routeTree()` patches cannot cross-wire routes. `MetaShape` keeps literal and tuple types. `RouteSelector` is `typeof P0 | typeof P1 | …`.

Regenerate after upgrading: `honey generate`.
