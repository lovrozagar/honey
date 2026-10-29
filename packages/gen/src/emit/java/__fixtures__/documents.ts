/**
 * The Java fixture registry (bit 16 phase c1): every SDK the Java gates build is one entry here, an OpenAPI document
 * with the emitter's options, shared with C#'s registry (`csharp/__fixtures__/documents.ts`) so both languages build
 * the same documents. Each SDK has both styles, the normal client and its `safe()` mirror (bit 21 i6), so no entry
 * is an error mode's.
 */
import crud from "../../../ir/__fixtures__/specs/python/crud.json" with { type: "json" }
import discriminated from "../../../ir/__fixtures__/specs/python/discriminated.json" with { type: "json" }
import invalidation from "../../../ir/__fixtures__/specs/python/invalidation.json" with { type: "json" }
import nested from "../../../ir/__fixtures__/specs/python/nested.json" with { type: "json" }
import refs from "../../../ir/__fixtures__/specs/python/refs.json" with { type: "json" }
import reservedWords from "../../../ir/__fixtures__/specs/python/reserved-words.json" with { type: "json" }
import integerEnumStatus from "../../../ir/__fixtures__/specs/go/integer-enum-status.json" with { type: "json" }
import nullablePrimitive from "../../../ir/__fixtures__/specs/go/nullable-primitive.json" with { type: "json" }
import { errors, http, httpExtraPaths } from "../../shared/__fixtures__/documents-http.ts"
import * as streams from "../../shared/__fixtures__/documents-streams.ts"
import { merged } from "../../shared/__fixtures__/merge.ts"
import type { JavaSdkOptions } from "../sdk.ts"

type Json = Readonly<Record<string, unknown>>

/** One SDK a Java gate builds: an OpenAPI document, made on use, and the emitter's options. */
export type JavaFixture = {
	readonly document: () => Readonly<Record<string, unknown>>
	readonly options?: JavaSdkOptions
}

/** The `http` document: the shared one with the request-build paths the C# registry adds (contract 47 §4.1). */
function httpDocument(): Readonly<Record<string, unknown>> {
	const base = http() as Readonly<Record<string, unknown>> & { paths: Record<string, unknown> }
	return { ...base, paths: { ...base.paths, ...httpExtraPaths() } }
}

/** The v0 fixtures the phase-b emitter accepts, merged into one document (as the C# `fixtures` entry). */
function fixtures(): Readonly<Record<string, unknown>> {
	return merged({
		crud,
		discriminated,
		invalidation,
		nested,
		refs,
		"reserved-words": reservedWords,
		"integer-enum-status": integerEnumStatus,
		"nullable-primitive": nullablePrimitive,
	})
}

/** A query parameter `name` of JSON type `type`. */
const query = (name: string, type: string, required = false) => ({ in: "query", name, required, schema: { type } })

/**
 * The shared `realtime` document with `clash.feed` beside it (C#'s registry path): two declared queries named like the
 * realtime fields, which the emitter claims `maxReconnectAttempts2` and `reconnectDelay2`, so the fold runs executed.
 */
function realtime(): Json {
	const shared = streams.realtime()
	const clash = {
		get: {
			operationId: "clash.feed",
			parameters: [
				query("channel", "string", true),
				query("max_reconnect_attempts", "integer"),
				query("reconnect_delay", "integer"),
			],
			responses: {
				200: {
					content: { "text/event-stream": { schema: { $ref: "#/components/schemas/Payload" } } },
					description: "ok",
				},
			},
			"x-realtime": true,
			"x-websocket": true,
		},
	}
	return { ...shared, paths: { ...(shared.paths as Json), "/realtime-clash/feed": clash } }
}

/**
 * Operations without an operationId, each named by the IR's derivation (`toIR`'s `deriveOperationIds`, as every
 * sibling emitter asks): ids shared by method and path (`x` thrice → `x`, `xPost`, `xPut`, `xPut2`), the root path
 * (`getRoot`), and a derived id beside an explicit dotted one (`deleteUsers2`): the IR's own collision document
 * (`ir/build.test.ts`). And a long derived id on two path params, whose call statements pass 100 columns (GJF wraps
 * them). Each answers a JSON object.
 */
export function derivedIds(): Json {
	const ok = {
		responses: { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
	}
	return {
		info: { title: "Anyrow", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/": { get: ok },
			"/a": { get: { ...ok, operationId: "x" }, post: { ...ok, operationId: "x" }, put: { ...ok, operationId: "x" } },
			"/b": { put: { ...ok, operationId: "x" } },
			"/users": { delete: { ...ok, operationId: "deleteUsers.all" }, post: ok },
			"/users/": { delete: ok },
			"/in-params/orgs/{orgId}/members/{memberId}": {
				get: {
					...ok,
					parameters: ["orgId", "memberId"].map((name) => ({
						in: "path",
						name,
						required: true,
						schema: { type: "string" },
					})),
				},
			},
		},
	}
}

/** A 200 whose JSON body is `schema`. */
const okJson = (schema: unknown) => ({ 200: { content: { "application/json": { schema } }, description: "ok" } })

/**
 * Answers a fallback would fit (bit 21 i6, C# i5's and Rust i4's lesson): any JSON value (`JsonNode`), a nullable
 * integer (`Long`) and a nullable object (a record), so an undecodable 2xx that became Ok (a NullNode, a null) would
 * show, which a non-null answer's own null check would hide.
 */
function lenient(): Json {
	const maybe = { properties: { id: { type: "string" } }, required: ["id"], type: ["object", "null"] }
	return {
		info: { title: "Lenient", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/any": { get: { operationId: "any.get", responses: okJson({}) } },
			"/count": { get: { operationId: "count.get", responses: okJson({ type: ["integer", "null"] }) } },
			"/maybe": { get: { operationId: "maybe.get", responses: okJson(maybe) } },
		},
	}
}

/* a string past the width once quoted, cut at its spaces */
const PROSE = "a value long enough to pass the width of a line once it is quoted and indented as an enum constant is"

/**
 * The layout's input-driven shapes (bit 21 i7a), each past the width so its google-java-format layout shows: a format
 * string's first argument apart (`%` in the server, the builder's three arguments), upper-case type names (a
 * TypeNameClassifier ambiguous start: `NAME.class` a regular dot, broken before `.class` past a short name like `AB`
 * only, `NAME.Deserializer.class` a type prefix), a name with
 * no letter (`_0`), long strings reflowed at their spaces, quotes and `\n` escapes, and a union of no selectable variant.
 */
function shapes(): Json {
	/* an upper-case name past the width once `.class` and its indent follow it: javaTypeName keeps it upper case */
	const CAPS = "CAPITALIZEDNAME".repeat(6).slice(0, 88)
	const S = { type: "string" }
	const variant = (kind: string) => ({
		properties: { kind: { const: kind, type: "string" }, note: S },
		required: ["kind"],
		type: "object",
	})
	return {
		components: {
			schemas: {
				[`${CAPS}A`]: variant("first"),
				[`${CAPS}B`]: variant("second"),
				AB: variant("third"),
				[CAPS]: {
					discriminator: { propertyName: "kind" },
					oneOf: [`${CAPS}A`, `${CAPS}B`, "AB"].map((name) => ({ $ref: `#/components/schemas/${name}` })),
				},
				Lone: { discriminator: { propertyName: "kind" }, oneOf: [S, { type: "integer" }] },
				Prose: {
					enum: [
						PROSE,
						`"quotes" first, then ${PROSE} and a \\ backslash`,
						`one line\nthen ${PROSE}`,
						`${PROSE} and a newline last\n`,
						`${PROSE}\r\n\r\nafter a blank line`,
					],
					type: "string",
				},
			},
		},
		info: { title: "Shapes", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/shapes/{0}": {
				get: {
					operationId: "shapes.get",
					parameters: [{ in: "path", name: "0", required: true, schema: S }],
					responses: okJson({ $ref: `#/components/schemas/${CAPS}` }),
				},
			},
			"/prose": { get: { operationId: "prose.get", responses: okJson({ $ref: "#/components/schemas/Prose" }) } },
			"/lone": { get: { operationId: "lone.get", responses: okJson({ $ref: "#/components/schemas/Lone" }) } },
		},
		servers: [{ url: "https://api.example.com/v1/with%20an%20encoded%20path/long/enough/to/pass/the/builder/width" }],
	}
}

/** Every Java SDK the gates build, by key. */
export const FIXTURES = {
	errors: { document: errors },
	fixtures: { document: fixtures },
	http: { document: httpDocument },
	/** a decode failure on answers a fallback would fit, never Ok (bit 21 i6) */
	lenient: { document: lenient },
	/** the event streams (phase d1): the shared `sse` document, as C#'s registry builds it */
	sse: { document: streams.sse },
	/** the WebSockets (phase d2a): the shared `ws` document */
	ws: { document: streams.ws },
	/** the resumable connections (phase d2b): the shared `realtime` document and `clash.feed` (its WebSocket files too) */
	realtime: { document: realtime },
	/** operations without an id, named by the IR's derivation and its collision suffixes (phase f) */
	derived: { document: derivedIds },
	/** every stream kind in one SDK: the core, the WebSocket and the realtime files together (the gating combinations) */
	streams: { document: () => merged({ realtime: realtime(), sse: streams.sse(), ws: streams.ws() }) },
	/** the layout's input-driven shapes, each past the width (bit 21 i7a) */
	shapes: { document: shapes },
} as const satisfies Record<string, JavaFixture>

export type FixtureKey = keyof typeof FIXTURES
