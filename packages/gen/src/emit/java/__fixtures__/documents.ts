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
	/** SSE and WebSocket operations in one SDK: the core and the WebSocket files together (the gating combinations) */
	streams: { document: () => merged({ sse: streams.sse(), ws: streams.ws() }) },
} as const satisfies Record<string, JavaFixture>

export type FixtureKey = keyof typeof FIXTURES
