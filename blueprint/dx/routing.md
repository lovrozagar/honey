# dx — routing

Routes are registered per method and built with the route builder before `.handler()`.

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `.get/.post/.put/.patch/.delete/.options/.head(path, …)` | yes | — | registers a route for that method + path | a builder without `.handler()` is reported at finalize | `routing/register.test.ts`, `integration/routing.test.ts` |
| path pattern `/a/:id` | — | — | named params matched by `pattern.ts`; value typed by the input schema | params are strings until the input schema validates them | `routing/pattern.test.ts` |
| path param constraint `:id(\d+)` | no | off | **proposed** [A8]; disambiguate numeric vs slug at match | low priority; input validation covers values today | decision only (bit 01) |
| trailing slash | — | canonical | redirected/normalized per `request-path.ts` | a double registration with/without slash is one route | `routing/request-path.test.ts` |
| `.meta({ … })` | no | `{}` | attaches OpenAPI operation meta; `extensions: { "x-*" }` reaches operation extensions | only `x-`-prefixed extension keys are allowed | `meta/meta-spec.test.ts` |
| `.meta({ extensions: { "x-realtime": true } })` | no | off | marks the operation as a realtime/resume endpoint | honey does not emit `x-realtime` itself; the consumer opts in | `integration/realtime.test.ts` |
| `operationId` (dotted) | no | derived | groups SDK resources (`users.list`) and names CLI/MCP verbs | the dotted name is the resource tree; keep it stable | `openapi/collect.test.ts` |
| sub-app `mergeTree` / mount | no | — | mounts a sub-app's tree under a prefix | an unknown route under a mount marks the tree stale (finalize) | `routing/tree-merge.test.ts`, `integration/routing.test.ts` |
| WS route | no | — | a WebSocket route with its own finalize plan (see `realtime.md`) | upgrade is adapter-specific; the plan is matched separately | `routing/ws-builder.test.ts`, `integration/realtime.test.ts` |
| `serveOpenApi(handle, options)` | no | — | subpath function from `./openapi`; mounts `${path}.json/.yaml/.yml` (+ an optional `docs` UI at `docsPath`) on `handle` as internal GETs (`meta({ internal: true })`, left out of the document/manifest/`$routes`), served with ETag + `Cache-Control: no-cache` + 304, cached per graph epoch; returns the handle. `handle` is the app or any middleware chain, so `serveOpenApi(app.use(auth), { path: "/private/spec" })` serves behind custom middleware at a custom path (this subsumes a separate `spec()`). Not an app method (H2/H23 — an app that doesn't serve docs bundles none of the generator) | a taken path is the ordinary duplicate-route error (no `/reference` fallback); the docs UI points at `stripPrefix + basePath + ${path}.json` | `openapi/serve.test.ts` |
| `serveManifest(app, options?)` | no | — | subpath function from `./openapi`; mounts `path` (default `/manifest.json`) as an internal GET serving the route manifest at published visibility; returns the app | unpublishable meta keys and `internal` routes are dropped | `openapi/manifest.test.ts` |
