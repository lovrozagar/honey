/**
 * The Java fixture registry (bit 16 phase c1): every SDK the Java gates build is one entry here, an OpenAPI document
 * with the emitter's options, shared with C#'s registry (`csharp/__fixtures__/documents.ts`) so both languages build
 * the same documents. The `…-safe` entries are the same documents with `throwOnError: false`.
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

/** Every Java SDK the gates build, by key. */
export const FIXTURES = {
	errors: { document: errors },
	fixtures: { document: fixtures },
	"fixtures-safe": { document: fixtures, options: { throwOnError: false } },
	http: { document: httpDocument },
	"http-safe": { document: httpDocument, options: { throwOnError: false } },
	/** the event streams (phase d1): the shared `sse` document, as C#'s registry builds it */
	sse: { document: streams.sse },
	"sse-safe": { document: streams.sse, options: { throwOnError: false } },
	/** the WebSockets (phase d2a): the shared `ws` document */
	ws: { document: streams.ws },
	"ws-safe": { document: streams.ws, options: { throwOnError: false } },
	/** the resumable connections (phase d2b): the shared `realtime` document and `clash.feed` (its WebSocket files too) */
	realtime: { document: realtime },
	"realtime-safe": { document: realtime, options: { throwOnError: false } },
	/** operations without an id, named by the IR's derivation and its collision suffixes (phase f) */
	derived: { document: derivedIds },
	/** every stream kind in one SDK: the core, the WebSocket and the realtime files together (the gating combinations) */
	streams: { document: () => merged({ realtime: realtime(), sse: streams.sse(), ws: streams.ws() }) },
} as const satisfies Record<string, JavaFixture>

export type FixtureKey = keyof typeof FIXTURES
