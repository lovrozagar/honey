# The OpenAPI document

honey writes an OpenAPI 3.1 document from the app's routes: their input and output schemas, errors,
metadata and response headers. `serveOpenApi(app, options)` mounts it as JSON and YAML, with Scalar or Swagger docs
pages at the paths you choose, and the build plugin writes it to disk. Options shape the document: `servers` with
`variables`, `tags` with `externalDocs` and `x-displayName`, and `webhooks` for the requests your API sends out.
Route `.meta({ extensions })` keys starting with `x-` reach the operation as they are, and `app.metaSpec(config)` maps
your own route metadata to operation fields.

## Example

```ts
import { honey } from "@lovrozagar/honey"
import { serveOpenApi } from "@lovrozagar/honey/openapi"
import { scalar } from "@lovrozagar/honey/openapi/scalar"

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
	docs: { "/docs": scalar },
})
```

`docs` maps each path to its page, so one document can have several: `docs: { "/docs/scalar": scalar,
"/docs/swagger": swagger }`. Each path sits under the handle's basePath, and each page points at the JSON URL the
browser sees. A page path that is taken, given twice, or holds a parameter throws before the call mounts anything.

## Prebuilt or external documents

`serveStaticOpenApi(app, options)` from `@lovrozagar/honey/openapi/static` serves a document the app did not
generate: the file the build plugin already wrote, a Workers asset binding, a URL, an inline value, or a loader of
your own. It imports none of the generator, so it is what a Worker serving a large committed document wants; an app
whose own routes are the document wants `serveOpenApi`.

```ts
import { honey } from "@lovrozagar/honey"
import { scalar } from "@lovrozagar/honey/openapi/scalar"
import { serveStaticOpenApi } from "@lovrozagar/honey/openapi/static"

const app = honey()

serveStaticOpenApi(app, {
	cacheControl: "public, s-maxage=3600",
	docs: { "/v1/openapi/scalar": scalar },
	json: { asset: "/openapi.json" },
	jsonPath: "/v1/openapi/spec",
	meta: { summary: "The published document" },
	yaml: { asset: "/openapi.yaml" },
})
```

`json` is required and `yaml` optional: with no `yaml` source, no YAML route is mounted, because nothing converts the
JSON at runtime. `path` (default `/openapi`) is the stem `.json`, `.yaml` and `.yml` hang off; `jsonPath` and
`yamlPath` replace that path outright. `docs` maps each path to its page, as in `serveOpenApi`. Routes are internal and
marked served, so the document never lists its own endpoints, and `meta` cannot lift that. `meta` goes on every route
the call mounts, the docs pages included, and takes what a route's own `.meta()` takes on that handle: honey's keys
(`security`, `summary`) and the ones the app declared with `metaType<T>()`, so middleware that reads route meta (a
`cacheControl` an app's own middleware turns into the header, a `security` an auth layer checks) sees it on the
document routes too. `serveOpenApi` and `serveManifest` take the same `meta`.

A document is loaded once per process or isolate, concurrent first requests sharing that load, and kept with the
upstream's strong `etag` when it sent one, else honey's own SHA-256 tag. A failed load is not kept and the next
request retries; a successful one is never refreshed, so a new upstream document needs a restart or a redeploy.
Nothing parses what is served: honey's own `content-type` is sent whatever the upstream said. A failing asset, a
binding that is missing or cannot fetch, and a failing loader are `internal_server_error`; a URL that fails or
answers non-2xx is `bad_gateway`.

## Guarding a document

`auth: basic({ realm, verify })` from `@lovrozagar/honey/openapi/auth` puts HTTP Basic in front of every route the
call mounts: the JSON, the YAML and each docs page. A browser asks for the pair once, then sends it with the docs
page's own request for the document.

```ts
import { honey } from "@lovrozagar/honey"
import { basic, credentialsMatch } from "@lovrozagar/honey/openapi/auth"
import { scalar } from "@lovrozagar/honey/openapi/scalar"
import { serveStaticOpenApi } from "@lovrozagar/honey/openapi/static"
import { swagger } from "@lovrozagar/honey/openapi/swagger"

type Env = { OPENAPI_DOCS_PASSWORD: string }

const app = honey<Env>()

serveStaticOpenApi(app, {
	docs: { "/v1/openapi/scalar": scalar, "/v1/openapi/swagger": swagger },
	json: { asset: "/openapi.public.json" },
	path: "/v1/openapi/spec",
})

serveStaticOpenApi(app, {
	auth: basic({
		realm: "Internal API",
		verify: ({ env, password, username }: { env: Env; password: string; username: string }) =>
			credentialsMatch({ password, username }, { password: env.OPENAPI_DOCS_PASSWORD, username: "docs" }),
	}),
	docs: { "/v1/internal/openapi/scalar": scalar },
	json: { asset: "/openapi.internal.json" },
	path: "/v1/internal/openapi/spec",
})
```

`verify` gets the request's `env` and the decoded pair, and may return a promise. `credentialsMatch` compares both
fields in constant time. A missing or malformed header, any scheme but `Basic`, and a pair `verify` refuses answer
401 with `WWW-Authenticate: Basic realm="…", charset="UTF-8"` and `Cache-Control: no-store`. The body goes through
your error boundary as `unauthorized`, so a custom formatter shapes it, and the challenge stays on the answer even
when your `onError` builds it. A `verify` that throws is a 500, never a refusal. An accepted request is answered
`private, no-store` with no ETag, so no shared cache keeps the document. `auth` beside `cacheControl` is a type error
and throws. `auth` changes nothing in a generated document: the routes stay internal.

## Reference

| Value                              | Default                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Watch for                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `servers`                          | `[{ url: stripPrefix }]` (v0)        | list of server URLs + `variables`, composed with basePath/stripPrefix/trailingSlash                                                                                                                                                                                                                                                                                                                                                                                                                                  | a single derived server loses multi-environment docs; set the list explicitly                                                                                               |
| server `variables`                 | —                                    | templated server URLs (`{region}`, `{env}`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | variable defaults must be valid against their enum                                                                                                                          |
| `tags`                             | the operation tags, first-seen order | the top-level `tags` are each operation's declared tags in first-seen order, merged by name with an explicit `tags` option (description, `externalDocs`, `x-displayName`). **Not** derived from the resource tree (that is gen — H2 forbids core reading it) and **not** auto-assigned from the dotted operationId (it would change every operation's output, and SDK grouping already comes from operationId). A declared tag no operation uses → warn                                                              | tags are for human doc tools; keep operationId stable for SDK grouping                                                                                                      |
| `externalDocs`                     | —                                    | per-tag / top-level external doc links                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                           |
| `x-displayName` / tag metadata     | —                                    | human display names for third-party doc tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | honey-namespaced `x-` extension                                                                                                                                             |
| `webhooks`                         | —                                    | the events the API sends, as a `webhookContract`; each is documented under OpenAPI 3.1 `webhooks` as a Standard Webhooks POST of `{ type, timestamp, data }` with its three signature headers and `x-honey-webhook`                                                                                                                                                                                                                                                                                                  | a free-form record is not accepted; TypeScript SDKs verify them, the other languages follow                                                                                 |
| `.meta({ extensions: { "x-*" } })` | —                                    | operation-level extensions reach the document (`x-realtime`, `x-websocket`, `x-mcp`, custom)                                                                                                                                                                                                                                                                                                                                                                                                                         | only `x-`-prefixed keys are allowed                                                                                                                                         |
| `app.metaSpec(config)`             | built-in policy                      | the codegen-time policy mapping custom route meta to operation fields (`string` / `{ key, map }` / `{ expand }` / `false` to hide; `map` and `expand` get a `MetaSpecContext<TMeta>` whose `meta` is the app's declared meta, typed), schema-metadata entries (rank/from/search/match/version), profiles (include/exclude), strictness (error/warn/off totality over meta keys), sub-app merge (parent wins, a sub's `false` always wins, conflicts reported), and the publishable meta keys for the served manifest | without it custom meta reaches the document only as raw `x-*`; metaSpec maps it to standard operation fields; diagnostics go to the caller's report hook, never the console |
| info (title/version/description)   | package-derived                      | the document `info` block                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | version should track the API, not the honey release                                                                                                                         |
