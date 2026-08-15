# Honey Response Namespace & Content-Type Safety

## Goal

Move response methods from flat `ctx.json()` to namespaced `ctx.res.json()`. Add compile-time content-type safety via method restriction + response branding. Extend runtime validation to catch content-type mismatches. Add missing response helpers (xml, csv, binary).

## Scope

- **In**: `ctx.res.*` namespace, `HoneyResponse` brand, `HoneyRes` class, `ApplyOutput` rewrite for method restriction, new helpers (xml/csv/binary), runtime content-type validation, `OutputSchemaDef` cleanup, `ctx.res.raw()` escape hatch, status keys on all body methods, generalized schema extraction types
- **Out**: cbor/msgpack encoders (user brings their own + binary()), streaming schema validation, non-JSON runtime schema validation (text/html bodies are strings — schema validation is documentation-only for those types)

## Problem

1. **Namespace pollution**: 10+ response methods (json, text, html, sse, stream, redirect, noContent, xml, csv, binary, raw) compete with middleware additions (ctx.auth, ctx.db) on flat ctx
2. **No content-type safety**: `.output({"application/json": {...}})` constrains `ctx.json()` args but doesn't prevent calling `ctx.text()` — silent mismatch compiles fine
3. **`new Response()` bypass**: handler can return raw `new Response()`, bypassing all type constraints and runtime validation — only caught at runtime
4. **Missing helpers**: xml, csv, binary have `OutputSchemaDef` entries but no ctx methods
5. **Request-only types in OutputSchemaDef**: `multipart/form-data` and `application/x-www-form-urlencoded` are request content types, not response

## Design

### `HoneyResponse` — branded Response subclass

```typescript
/* response.ts */
const HONEY_RESPONSE = Symbol("honey.response")

export class HoneyResponse extends Response {
	readonly [HONEY_RESPONSE] = true

	constructor(body?: BodyInit | null, init?: ResponseInit) {
		super(body, init)
	}

	/** Brand an existing Response (for proxying, cached responses) */
	static from(response: Response): HoneyResponse {
		return new HoneyResponse(response.body, {
			headers: response.headers,
			status: response.status,
			statusText: response.statusText,
		})
	}
}
```

Why a subclass, not a phantom brand:

- No `as unknown as X` casts (banned by code style)
- `new HoneyResponse(body, init)` identical to `new Response(body, init)`
- `instanceof` works at runtime (useful for validation layer)
- Symbol property provides structural type discrimination — `new Response()` doesn't satisfy `HoneyResponse`

### `HoneyRes` — response builder class

```typescript
/* response.ts */
export class HoneyRes {
	/** JSON — application/json */
	json(statusKey: StatusKey, data: unknown, opts?: ResponseOptions): HoneyResponse {
		const headers = new Headers({ "content-type": "application/json" })
		applyResponseOptions(headers, opts)
		return new HoneyResponse(JSON.stringify(data), {
			headers,
			status: statusKeyToCode[statusKey],
		})
	}

	/** Plain text — text/plain; charset=utf-8 */
	text(statusKey: StatusKey, body: string, opts?: ResponseOptions): HoneyResponse {
		const headers = new Headers({ "content-type": "text/plain; charset=utf-8" })
		applyResponseOptions(headers, opts)
		return new HoneyResponse(body, { headers, status: statusKeyToCode[statusKey] })
	}

	/** HTML — text/html; charset=utf-8 */
	html(statusKey: StatusKey, body: string, opts?: ResponseOptions): HoneyResponse {
		const headers = new Headers({ "content-type": "text/html; charset=utf-8" })
		applyResponseOptions(headers, opts)
		return new HoneyResponse(body, { headers, status: statusKeyToCode[statusKey] })
	}

	/** XML — application/xml */
	xml(statusKey: StatusKey, body: string, opts?: ResponseOptions): HoneyResponse {
		const headers = new Headers({ "content-type": "application/xml" })
		applyResponseOptions(headers, opts)
		return new HoneyResponse(body, { headers, status: statusKeyToCode[statusKey] })
	}

	/** CSV — text/csv; charset=utf-8 */
	csv(statusKey: StatusKey, body: string, opts?: ResponseOptions): HoneyResponse {
		const headers = new Headers({ "content-type": "text/csv; charset=utf-8" })
		applyResponseOptions(headers, opts)
		return new HoneyResponse(body, { headers, status: statusKeyToCode[statusKey] })
	}

	/** Binary — application/octet-stream */
	binary(
		statusKey: StatusKey,
		body: ArrayBuffer | Uint8Array,
		opts?: ResponseOptions,
	): HoneyResponse {
		const headers = new Headers({ "content-type": "application/octet-stream" })
		applyResponseOptions(headers, opts)
		return new HoneyResponse(body, { headers, status: statusKeyToCode[statusKey] })
	}

	/** Server-Sent Events — text/event-stream (always 200) */
	sse(callback: (stream: SSEStream) => Promise<void>, opts?: SSEOptions): HoneyResponse {
		/* same implementation as current ctx.sse(), returns HoneyResponse */
	}

	/** Raw streaming — no automatic content-type (always 200, customizable) */
	stream(
		callback: (writable: WritableStream) => Promise<void>,
		opts?: ResponseOptions,
	): HoneyResponse {
		/* same implementation as current ctx.stream(), returns HoneyResponse */
	}

	/** Redirect — sets location header (default 302) */
	redirect(url: string, opts?: ResponseOptions): HoneyResponse {
		const headers = new Headers({ location: url })
		applyResponseOptions(headers, opts)
		return new HoneyResponse(null, { headers, status: opts?.status ?? 302 })
	}

	/** No content — 204, null body */
	noContent(opts?: ResponseOptions): HoneyResponse {
		const headers = new Headers()
		applyResponseOptions(headers, opts)
		return new HoneyResponse(null, { headers, status: 204 })
	}

	/** Escape hatch — brand an existing Response */
	raw(response: Response): HoneyResponse {
		return HoneyResponse.from(response)
	}
}
```

Content-type mapping:

| Method | Content-Type                 | Body Type                      |
| ------ | ---------------------------- | ------------------------------ |
| json   | `application/json`           | `unknown` (schema-constrained) |
| text   | `text/plain; charset=utf-8`  | `string`                       |
| html   | `text/html; charset=utf-8`   | `string`                       |
| xml    | `application/xml`            | `string`                       |
| csv    | `text/csv; charset=utf-8`    | `string`                       |
| binary | `application/octet-stream`   | `ArrayBuffer \| Uint8Array`    |
| sse    | `text/event-stream`          | callback                       |
| stream | (user sets via opts.headers) | callback                       |

### `HoneyContext` changes

```typescript
/* context.ts */
export class HoneyContext<TEnv = Record<string, unknown>> {
	readonly env: TEnv
	readonly params: Record<string, string>
	readonly req: Request
	readonly res: HoneyRes

	/* keep: cookies, headers, search, background, url (lazy) */
	/* REMOVE: json, text, html, noContent, redirect, sse, stream */
	/* REMOVE: jsonFromError — becomes standalone createErrorResponse() */

	constructor(opts: {
		env: TEnv
		params: Record<string, string>
		req: Request
		url?: URL
		waitUntil?: (p: Promise<unknown>) => void
	}) {
		this.req = opts.req
		this.env = opts.env
		this.params = opts.params
		this.res = new HoneyRes()
		this._url = opts.url
		this._waitUntil = opts.waitUntil
	}
}
```

`jsonFromError` moves to standalone function — only used internally in `fetch()` error handling:

```typescript
/* response.ts */
export function createErrorResponse(error: HoneyError, formatter: ErrorFormatter): HoneyResponse {
	const defaultShape: Record<string, unknown> = {
		error_key: error.errorKey,
		fields: error.fields,
		message: error.message,
		status: error.status,
		status_key: error.statusKey,
		success: false,
	}
	const body = formatter(error, defaultShape)
	return new HoneyResponse(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status: error.status,
	})
}
```

### `ApplyOutput` rewrite — three-layer type safety

**Layer 1: Content-type to method mapping**

```typescript
/* types.ts */
type ContentTypeMethodMap = {
	"application/json": "json"
	"application/octet-stream": "binary"
	"application/xml": "xml"
	"text/csv": "csv"
	"text/event-stream": "sse"
	"text/html": "html"
	"text/plain": "text"
}

/** Methods always available regardless of output declaration */
type UniversalResMethods = "noContent" | "raw" | "redirect" | "stream"

/** Derive allowed methods from declared output content types */
type AllowedResMethods<TOutput> = {
	[CT in keyof ContentTypeMethodMap]: CT extends keyof TOutput ? ContentTypeMethodMap[CT] : never
}[keyof ContentTypeMethodMap]
```

**Layer 2: Generalized schema extraction**

```typescript
/* types.ts */

/** Extract schemas for any content type — generalizes ExtractJsonSchemas */
type ExtractSchemas<T, CT extends string> = T extends {
	[K in CT]: infer S extends Record<string, StandardSchemaLike>
}
	? S
	: never

/** ExtractJsonSchemas becomes an alias */
type ExtractJsonSchemas<T> = ExtractSchemas<T, "application/json">
```

**Layer 3: Body method constraint**

```typescript
/* index.ts */

/**
 * Constrain a body method's status keys + body type when schemas are declared.
 * When no schemas for that CT → keep original (unconstrained) method.
 * When CT not in output → method not included (excluded by AllowedResMethods).
 */
type ConstrainBodyMethod<TRes, TOutput, CT extends string, Method extends string> =
	ExtractSchemas<TOutput, CT> extends infer TSchemas
		? [TSchemas] extends [never]
			? Pick<TRes, Method & keyof TRes> /* CT in output but no schemas → original sig */
			: TSchemas extends Record<string, StandardSchemaLike>
				? {
						[M in Method]: <K extends keyof TSchemas & string>(
							statusKey: K,
							body: InferOutput<TSchemas[K]>,
							opts?: ResponseOptions,
						) => HoneyResponse
					}
				: Pick<TRes, Method & keyof TRes>
		: Pick<TRes, Method & keyof TRes>

/**
 * Combined ApplyOutput — restricts ctx.res to declared content types,
 * constrains body method signatures when schemas are declared.
 */
type ApplyOutput<TCtx, TOutput> = [keyof TOutput] extends [never]
	? TCtx /* no output declared → all methods on res */
	: TCtx extends { readonly res: infer TRes }
		? Omit<TCtx, "res"> & {
				readonly res: /* universal methods — always available */
				Pick<TRes, UniversalResMethods & keyof TRes> &
					/* content-type gated methods — constrained when schemas declared */
					("application/json" extends keyof TOutput
						? ConstrainBodyMethod<TRes, TOutput, "application/json", "json">
						: {}) &
					("text/plain" extends keyof TOutput
						? ConstrainBodyMethod<TRes, TOutput, "text/plain", "text">
						: {}) &
					("text/html" extends keyof TOutput
						? ConstrainBodyMethod<TRes, TOutput, "text/html", "html">
						: {}) &
					("application/xml" extends keyof TOutput
						? ConstrainBodyMethod<TRes, TOutput, "application/xml", "xml">
						: {}) &
					("text/csv" extends keyof TOutput
						? ConstrainBodyMethod<TRes, TOutput, "text/csv", "csv">
						: {}) &
					("application/octet-stream" extends keyof TOutput
						? ConstrainBodyMethod<TRes, TOutput, "application/octet-stream", "binary">
						: {}) &
					("text/event-stream" extends keyof TOutput ? Pick<TRes, "sse" & keyof TRes> : {})
			}
		: TCtx
```

**Effect examples:**

```typescript
/* no output → all methods available */
.handler((ctx) => {
  ctx.res.json("ok", data)      // any StatusKey, any data
  ctx.res.text("ok", "hello")   // any StatusKey, string
  ctx.res.html("ok", "<h1>")   // any StatusKey, string
  ctx.res.redirect("/home")     // always available
})

/* JSON only */
.output({ "application/json": { ok: z.object({ id: z.string() }) } })
.handler((ctx) => {
  ctx.res.json("ok", { id: "1" })  // constrained to "ok" + typed data
  ctx.res.text(...)                 // TS ERROR — text not in declared output
  ctx.res.redirect("/home")         // always available
  ctx.res.noContent()               // always available
})

/* JSON + text with schemas */
.output({
  "application/json": { ok: z.object({ count: z.number() }) },
  "text/plain": { ok: z.literal("done"), accepted: z.literal("processing") }
})
.handler((ctx) => {
  ctx.res.json("ok", { count: 42 })       // constrained
  ctx.res.text("ok", "done")              // constrained to "ok" | "accepted"
  ctx.res.text("accepted", "processing")  // constrained body type
  ctx.res.html(...)                        // TS ERROR — html not declared
})

/* new Response() bypass blocked */
.handler((ctx) => new Response("lol"))  // TS ERROR — not HoneyResponse
```

### `OutputSchemaDef` cleanup

Remove request-only content types:

```typescript
export type OutputSchemaDef = {
	"application/cbor"?: StatusSchemaMap
	"application/json"?: StatusSchemaMap
	"application/msgpack"?: StatusSchemaMap
	"application/octet-stream"?: StatusSchemaMap
	"application/pdf"?: StatusSchemaMap
	"application/xml"?: StatusSchemaMap
	"text/csv"?: StatusSchemaMap
	"text/event-stream"?: StatusSchemaMap
	"text/html"?: StatusSchemaMap
	"text/plain"?: StatusSchemaMap
} & Record<string, StatusSchemaMap>
```

Removed: `"application/x-www-form-urlencoded"`, `"multipart/form-data"` — these are request-side only.

### Runtime content-type validation

Extend `fetch()` to check content-type header against declared output types. This is the defense-in-depth layer that catches `ctx.res.raw()` misuse and any edge cases the type system can't prevent.

```typescript
/* in fetch(), after handler returns response, before existing schema validation */
if (handler.os && ovMode !== "off") {
	const ct = response.headers.get("content-type")

	/* Layer 1: content-type must match a declared output type */
	if (ct) {
		const declaredTypes = Object.keys(handler.os)
		const matches = declaredTypes.some((t) => ct.startsWith(t))
		if (!matches) {
			throw new HoneyError({
				errorKey: "output_content_type_mismatch",
				message: `Response content-type "${ct}" not in declared output: ${declaredTypes.join(", ")}`,
				status: "internal_server_error",
			})
		}
	}

	/* Layer 2: existing JSON schema validation */
	if (ct?.startsWith("application/json") && handler.ov) {
		const sk = codeToStatusKey[response.status]
		if (sk) {
			const cloned = response.clone()
			const data: unknown = await cloned.json()
			await handler.ov(sk, data)
		}
	}
}
```

500 (internal_server_error), not 501 — content-type mismatch is the developer's bug, not the client's.

### Status keys on all body methods

All body methods take `statusKey` as first argument, consistent with `json()`:

```typescript
ctx.res.json("ok", { items: [], total: 0 })
ctx.res.text("ok", "hello world")
ctx.res.html("ok", "<h1>Hello</h1>")
ctx.res.xml("ok", "<root><item>1</item></root>")
ctx.res.csv("ok", "name,age\nAlice,30")
ctx.res.binary("ok", new Uint8Array([1, 2, 3]))
```

Methods WITHOUT status keys (different semantics):

| Method    | Why no statusKey                                                       |
| --------- | ---------------------------------------------------------------------- |
| sse       | Always 200, streaming                                                  |
| stream    | Always 200 (customizable via opts.status)                              |
| redirect  | Uses opts.status (default 302) — redirect codes are well-known numbers |
| noContent | Always 204                                                             |
| raw       | Pass-through, user controls everything                                 |

### Handler return type

```typescript
/* RouteBuilder.handler() — user-facing, branded */
handler(fn: (ctx: HandlerCtx<...>) => HoneyResponse | Promise<HoneyResponse>): Honey<...>

/* RouteHandler.fn in tree.ts — internal, unbranded (HoneyResponse extends Response) */
fn: (ctx: unknown) => Response | Promise<Response>
```

The brand exists at the RouteBuilder type level only. At runtime, `HoneyResponse extends Response`, so all internal machinery (executeChain, middleware, RouteHandler) works with `Response` unchanged.

### Middleware interaction

Middleware is unaffected by the `HoneyResponse` brand:

- Middleware's `TCtx` includes `res: HoneyRes` (from HoneyContext) — can call `ctx.res.json()` to short-circuit
- `executeChain` returns `Promise<Response>` — `HoneyResponse` satisfies this via subclass
- `MiddlewareResult<TAdds>` stays `Response & { __adds }` — no change
- Middleware that short-circuits constructs responses via `ctx.res.*` which returns `HoneyResponse`

### Demo app (after)

```typescript
const orgById = base
	.get("/orgs/:orgId")
	.meta({
		auth: "required",
		openApi: { summary: "Get organization by ID", tags: ["Organization"] },
	})
	.errors("not_found")
	.handler((c) => {
		const org = OrgService.getById(c)
		return c.res.json("ok", org)
	})

export const app = base
	.get("/orgs")
	.input({ search: z.object({ limit: z.number(), offset: z.number() }) })
	.output({
		"application/json": {
			ok: z.object({ items: z.string().array(), total: z.number() }),
		},
	})
	.handler((c) => {
		const result = OrgService.list(c)
		return c.res.json("ok", { items: result, total: result.length })
	})
	.post("/orgs")
	.input({ json: z.object({ name: z.string(), slug: z.string() }) })
	.errors("org_slug_taken", "org_limit_reached")
	.handler((c) => {
		const org = OrgService.create(c)
		return c.res.json("created", org)
	})
```

## Files to Change

| File                     | Changes                                                                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/response.ts`        | **NEW** — `HoneyResponse`, `HoneyRes`, `createErrorResponse`, `applyResponseOptions` (moved from context.ts)                                                                                                                              |
| `src/context.ts`         | Remove all response methods, remove `_errorFormatter`, add `res: HoneyRes`, remove `serializeCookie` + `applyResponseOptions` (moved to response.ts)                                                                                      |
| `src/types.ts`           | Remove `multipart/form-data` + `x-www-form-urlencoded` from `OutputSchemaDef`, add `ContentTypeMethodMap`, `UniversalResMethods`, `AllowedResMethods`, generalize `ExtractSchemas`, add `ExtractJsonSchemas` alias                        |
| `src/index.ts`           | Rewrite `ApplyOutput`, add `ConstrainBodyMethod`, update `HandlerCtx` return type, update `fetch()` error handling to use `createErrorResponse`, add content-type mismatch validation, remove `_errorFormatter` from context construction |
| `src/tree.ts`            | No changes — `RouteHandler.fn` stays `Response` (HoneyResponse extends Response)                                                                                                                                                          |
| `src/middleware.ts`      | No changes — middleware chain uses `Response`, HoneyResponse satisfies it                                                                                                                                                                 |
| `src/validation.ts`      | No changes                                                                                                                                                                                                                                |
| `src/error.ts`           | No changes                                                                                                                                                                                                                                |
| `src/index.ts` (exports) | Export `HoneyResponse`, `HoneyRes`, `createErrorResponse` from barrel                                                                                                                                                                     |
| `tests/**`               | Update all `ctx.json()` → `ctx.res.json()`, `ctx.text("x")` → `ctx.res.text("ok", "x")`, etc.                                                                                                                                             |
| `demo/src/app.ts`        | Update response method calls                                                                                                                                                                                                              |

## Implementation Steps

### Phase 1: New response module

- [ ] Create `src/response.ts` — `HoneyResponse` class, `HoneyRes` class, `createErrorResponse` fn
- [ ] Move `applyResponseOptions`, `serializeCookie`, `CookieOptions`, `ResponseOptions`, `SSEOptions`, `SSEEvent`, `SSEStream` from context.ts to response.ts
- [ ] Implement all response methods on `HoneyRes` using `HoneyResponse` instead of `Response`
- [ ] Add new methods: `xml()`, `csv()`, `binary()`, `raw()`

### Phase 2: Context migration

- [ ] Remove all response methods from `HoneyContext`
- [ ] Remove `_errorFormatter` field from `HoneyContext`
- [ ] Add `readonly res: HoneyRes` to `HoneyContext`
- [ ] Update constructor — create `HoneyRes` instance, remove errorFormatter param

### Phase 3: Type system

- [ ] Add `ContentTypeMethodMap`, `UniversalResMethods`, `AllowedResMethods` to types.ts
- [ ] Add `ExtractSchemas<T, CT>` generalized type, make `ExtractJsonSchemas` an alias
- [ ] Remove `multipart/form-data`, `application/x-www-form-urlencoded` from `OutputSchemaDef`
- [ ] Rewrite `ApplyOutput` — transforms `ctx.res` instead of flat ctx, uses `ConstrainBodyMethod`
- [ ] Handler callback return type: `HoneyResponse | Promise<HoneyResponse>`

### Phase 4: fetch() updates

- [ ] Replace `makeErrorCtx().jsonFromError(err)` with `createErrorResponse(err, formatter)` throughout fetch()
- [ ] Add content-type mismatch validation before existing JSON schema validation
- [ ] Error key: `"output_content_type_mismatch"`, status: `"internal_server_error"`

### Phase 5: Tests

- [ ] Update all `ctx.json(key, data)` → `ctx.res.json(key, data)` (~50+ call sites)
- [ ] Update all `ctx.text(body)` → `ctx.res.text("ok", body)` (~30+ call sites)
- [ ] Update all `ctx.html(body)` → `ctx.res.html("ok", body)`
- [ ] Update all `ctx.noContent()` → `ctx.res.noContent()`
- [ ] Update all `ctx.redirect(url)` → `ctx.res.redirect(url)`
- [ ] Update all `ctx.sse(cb)` → `ctx.res.sse(cb)`
- [ ] Update all `ctx.stream(cb)` → `ctx.res.stream(cb)`
- [ ] New unit tests for `HoneyResponse` (brand, instanceof, from())
- [ ] New unit tests for `HoneyRes` (xml, csv, binary, raw)
- [ ] New unit tests for content-type method restriction (compile-time, use type assertions)
- [ ] New unit tests for content-type mismatch runtime validation
- [ ] New unit tests for status keys on text/html (status code mapping)

### Phase 6: Demo & downstream

- [ ] Update demo app response calls
- [ ] Update e2e app response calls
- [ ] Regenerate `*.gen.*` files
- [ ] Update OpenAPI generation if it references response types

## Decisions

| Decision                                                      | Rationale                                                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ctx.res.*` over flat `ctx.*`                                 | Namespace separation, room for growth, symmetric with `ctx.req`, middleware additions don't compete       |
| `HoneyResponse extends Response` over phantom brand           | No `as` casts, instanceof works, `new Response()` is TS error (structural difference via symbol property) |
| Method restriction via `ApplyOutput` over per-method branding | Simpler, fewer types, builds on existing pattern                                                          |
| Status keys on ALL body methods                               | Consistency with json(), explicit status codes, enables future schema constraints per content type        |
| No status key on sse/stream/redirect/noContent                | Different semantics — streaming is 200, redirect has its own codes, noContent is 204                      |
| `createErrorResponse` standalone function                     | Error formatting is internal, not part of handler API — keeps ctx.res clean                               |
| 500 for content-type mismatch                                 | Developer's bug (declared one type, returned another), not client error                                   |
| `ctx.res.raw()` escape hatch                                  | Legitimate use: proxying, cached responses — user explicitly opts out of type safety                      |
| Remove form-urlencoded/multipart from OutputSchemaDef         | These are request-side content types, not response types                                                  |
| Generalized `ExtractSchemas<T, CT>`                           | Same constraint pattern works for all content types, not just JSON                                        |

## Discovered

- Middleware already uses phantom brand: `MiddlewareResult<TAdds> = Response & { __adds }` — similar pattern, validates the approach
- `jsonFromError` only used internally in `fetch()` error handling — safe to remove from public API
- `OutputSchemaDef` has `& Record<string, StatusSchemaMap>` — custom content types already extensible
- `executeChain` returns `Promise<Response>` — `HoneyResponse` satisfies via subclass, zero middleware changes
- Status keys already cover all HTTP statuses 200-504 — reusing for non-JSON methods is natural
- `applyResponseOptions` is a pure function (takes Headers + opts) — cleanly moves to response.ts
- SSE doesn't fit the status key pattern — callback-based, always 200, different signature

## Rejected

| Rejected                                                          | Why                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Phantom brand (`Response & { [symbol]: true }`)                   | Requires `as unknown as X` casts (banned by code style rules)                                                                  |
| Per-method branding (each returns `JsonResponse`, `TextResponse`) | Over-complex, method restriction achieves same goal with fewer types                                                           |
| Optional statusKey on non-JSON methods                            | Inconsistent API, overload disambiguation is fragile (`text("ok")` — body or status key?)                                      |
| Fluent status API (`ctx.res.ok.text("hello")`)                    | Massive proxy surface (30+ status keys x 10+ methods), not worth complexity                                                    |
| cbor/msgpack helpers                                              | Need encoder libraries — users use `binary()` + custom content-type header                                                     |
| Non-JSON runtime schema validation                                | text/html bodies are strings, schema validation doesn't apply meaningfully at runtime — schemas serve as OpenAPI documentation |
| Keeping `jsonFromError` on ctx                                    | Only used internally, pollutes handler API, couples context to error formatting                                                |
| Keeping flat `ctx.json()`                                         | Growing method count (now 11) crowds out middleware additions, no namespace separation                                         |
