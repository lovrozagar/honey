# The OpenAPI document

honey writes an OpenAPI 3.1 document from the app's routes: their input and output schemas, errors,
metadata and response headers. `serveOpenApi(app, options)` mounts it as JSON and YAML, with an optional Scalar or
Swagger docs page, and the build plugin writes it to disk. Options shape the document: `servers` with
`variables`, `tags` with `externalDocs` and `x-displayName`, and `webhooks` for the requests your API sends out.
Route `.meta({ extensions })` keys starting with `x-` reach the operation as they are, and `app.metaSpec(config)` maps
your own route metadata to operation fields.

## Example

```ts
import { honey } from "@lovrozagar/honey"
import { serveOpenApi } from "@lovrozagar/honey/openapi"

const app = honey()

app
	.get("/orders")
	.meta({ summary: "List orders", tags: ["orders"] })
	.handler((ctx) => ctx.res.json("ok", []))

serveOpenApi(app, {
	title: "Shop",
	version: "1.2.0",
	servers: [{ url: "https://{region}.api.example.com", variables: { region: { default: "eu" } } }],
	tags: [{ name: "orders", description: "Placing and tracking orders" }],
	docs: "scalar",
})
```

## Reference

| Value                              | Default                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                            | Watch for                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `servers`                          | `[{ url: stripPrefix }]` (v0)        | list of server URLs + `variables`, composed with basePath/stripPrefix/trailingSlash                                                                                                                                                                                                                                                                                                                                                                     | a single derived server loses multi-environment docs; set the list explicitly                                                                                               |
| server `variables`                 | —                                    | templated server URLs (`{region}`, `{env}`)                                                                                                                                                                                                                                                                                                                                                                                                             | variable defaults must be valid against their enum                                                                                                                          |
| `tags`                             | the operation tags, first-seen order | the top-level `tags` are each operation's declared tags in first-seen order, merged by name with an explicit `tags` option (description, `externalDocs`, `x-displayName`). **Not** derived from the resource tree (that is gen — H2 forbids core reading it) and **not** auto-assigned from the dotted operationId (it would change every operation's output, and SDK grouping already comes from operationId). A declared tag no operation uses → warn | tags are for human doc tools; keep operationId stable for SDK grouping                                                                                                      |
| `externalDocs`                     | —                                    | per-tag / top-level external doc links                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                           |
| `x-displayName` / tag metadata     | —                                    | human display names for third-party doc tools                                                                                                                                                                                                                                                                                                                                                                                                           | honey-namespaced `x-` extension                                                                                                                                             |
| `webhooks`                         | —                                    | declare outbound webhooks (OpenAPI 3.1 `webhooks`); the generator emits a typed payload parser + signature-verify helper per SDK                                                                                                                                                                                                                                                                                                                        | the document side is core; the SDK helper is `honey-codegen` (see `dx/codegen.md`)                                                                                          |
| `.meta({ extensions: { "x-*" } })` | —                                    | operation-level extensions reach the document (`x-realtime`, `x-websocket`, `x-mcp`, custom)                                                                                                                                                                                                                                                                                                                                                            | only `x-`-prefixed keys are allowed                                                                                                                                         |
| `app.metaSpec(config)`             | built-in policy                      | the codegen-time policy mapping custom route meta to operation fields (`string` / `{ key, map }` / `{ expand }` / `false` to hide), schema-metadata entries (rank/from/search/match/version), profiles (include/exclude), strictness (error/warn/off totality over meta keys), sub-app merge (parent wins, a sub's `false` always wins, conflicts reported), and the publishable meta keys for the served manifest                                      | without it custom meta reaches the document only as raw `x-*`; metaSpec maps it to standard operation fields; diagnostics go to the caller's report hook, never the console |
| info (title/version/description)   | package-derived                      | the document `info` block                                                                                                                                                                                                                                                                                                                                                                                                                               | version should track the API, not the honey release                                                                                                                         |
