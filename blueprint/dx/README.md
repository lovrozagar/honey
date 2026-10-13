# dx — the user contract

One file per public surface area. Each file lists **every** value a user passes: whether it is required, its default, the outcome it produces, the pitfall it carries, and the test that pins it. A value not listed here does not exist. When a bit and a `dx/` file disagree, the `dx/` file wins and the bit is corrected in the same change.

Test names point at the v1 homes (colocated unit sibling, or a feature-named `tests/integration/*` suite). New capabilities (A1–A7, B1–B3, C1) carry their gap id.

| file | area |
| --- | --- |
| `app-settings.md` | `honey()` and the app-level chain (`trustProxy`, `basePath`, `context`, `onError`, telemetry) |
| `routing.md` | route registration, methods, patterns, the route builder |
| `input-output.md` | `.input()` / `.output()`, media types, response headers, binary, errors |
| `middleware.md` | `use()` and the edge middleware set (cors, secure-headers, csrf, rate-limit, compress, request-id, timeout, body-limit, server-timing, powered-by, ip-restrict) |
| `realtime.md` | ws / realtime / sse, resume, reconnect |
| `openapi.md` | the emitted OpenAPI document: servers, variables, tags, externalDocs, webhooks |
| `observability.md` | logger, onError, request log, request id, tracing, privacy, the combination matrix |
| `proxy.md` | `proxy()`/gateway forwarding, header mutation, traceparent, SSRF corpus |
| `static.md` | `staticFiles()` serving, range/206, conditional GET, cache-control |
| `cookies.md` | `ctx.cookies` get/set, signed cookies |
| `i18n.md` | locale negotiation, `interpolate`, `dict`, error-message i18n |
| `crypto.md` | HMAC sign/verify, random, base64url (WebCrypto) |
| `plugin.md` | the build-time plugin (type gen, route-tree, codegen wiring) |
| `client.md` | generated-SDK consumer config (base url, auth, timeout, per-call overrides, raw response) |
| `conformance.md` | the SDK conformance matrix — every feature × every target (6 SDKs + CLI + MCP) against the live reference server |
| `codegen.md` | `honey-codegen` options (targets, output, formatter, vendored runtime) |
| `cli.md` | generated CLI flags and conventions |
| `mcp.md` | MCP server emit options (tools, output schema, annotations) |
