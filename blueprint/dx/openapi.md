# dx — OpenAPI document

How the author configures the emitted OpenAPI 3.1 document (B1/B2/B3). The document is produced by core (`openapi/*`); these are the author-facing knobs. Human docs (Scalar/Swagger) and the `./openapi` serving entry are covered under routing/app surface.

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `servers` | no | `[{ url: stripPrefix }]` (v0) | **[B1]** list of server URLs + `variables`, composed with basePath/stripPrefix/trailingSlash | a single derived server loses multi-environment docs; set the list explicitly | `openapi/servers.test.ts` |
| server `variables` | no | — | **[B1]** templated server URLs (`{region}`, `{env}`) | variable defaults must be valid against their enum | `openapi/servers.test.ts` |
| `tags` | no | derived from the resource tree | **[B2]** operation grouping; explicit tags override the dotted-operationId grouping | SDK resource grouping still comes from operationId, not tags — keep operationId stable | `openapi/tags.test.ts` |
| `externalDocs` | no | — | **[B2]** per-tag / top-level external doc links | — | `openapi/tags.test.ts` |
| `x-displayName` / tag metadata | no | — | **[B2]** human display names for third-party doc tools | honey-namespaced `x-` extension | `openapi/tags.test.ts` |
| `webhooks` | no | — | **[B3]** declare outbound webhooks (OpenAPI 3.1 `webhooks`); the generator emits a typed payload parser + signature-verify helper per SDK (`emit/shared/webhooks.ts`) | the document side is core; the SDK helper is `honey-codegen` (see `dx/codegen.md`) | `openapi/webhooks.test.ts` |
| `.meta({ extensions: { "x-*" } })` | no | — | operation-level extensions reach the document (`x-realtime`, `x-websocket`, `x-mcp`, custom) | only `x-`-prefixed keys are allowed | `meta/meta-spec.test.ts` |
| info (title/version/description) | no | package-derived | the document `info` block | version should track the API, not the honey release | `openapi/document.test.ts` |
