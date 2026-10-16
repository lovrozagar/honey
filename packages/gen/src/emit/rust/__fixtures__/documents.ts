/**
 * The fixture registry (contract 18 §7.1, Fb5): every crate a default run compiles is one entry here, an
 * OpenAPI document with the emitter's options or a dependency-free crate, and every Rust compile entry
 * point takes a `FixtureKey`, so the type checker holds the G17 budget of 16 documents and the structure
 * test only counts entries. A floor check of an entry, the driver and a consumer program are not further
 * documents: they compile the same entry's crate.
 */
import crud from "../../../ir/__fixtures__/specs/go/crud.json" with { type: "json" }
import invalidation from "../../../ir/__fixtures__/specs/go/invalidation.json" with { type: "json" }
import sse from "../../../ir/__fixtures__/specs/go/sse.json" with { type: "json" }
import ws from "../../../ir/__fixtures__/specs/go/ws.json" with { type: "json" }
import errorKeys from "../../../ir/__fixtures__/specs/rust/error-keys.json" with { type: "json" }
import formBody from "../../../ir/__fixtures__/specs/rust/form-body.json" with { type: "json" }
import realtimeLongpoll from "../../../ir/__fixtures__/specs/rust/realtime-longpoll.json" with { type: "json" }
import realtimeSse from "../../../ir/__fixtures__/specs/rust/realtime-sse.json" with { type: "json" }
import realtime from "../../../ir/__fixtures__/specs/rust/realtime.json" with { type: "json" }
import { adversarialCorpus } from "../../shared/__fixtures__/adversarial-corpus.ts"
import type { RustSdkOptions } from "../sdk.ts"
import { errors, http } from "./documents-http.ts"
import { relative, surface, types } from "./documents-specs.ts"
import * as streams from "./documents-streams.ts"

/**
 * One crate a run compiles: an OpenAPI document the emitter writes a crate for (made on use: a module runs no
 * code as it loads), or a dependency-free crate's files.
 */
export type RustFixture =
	| { readonly document: () => Readonly<Record<string, unknown>>; readonly options?: RustSdkOptions }
	| { readonly files: Readonly<Record<string, string>> }

type Json = Readonly<Record<string, unknown>>

/** `Kebab-key` as a component prefix: `form-body` → `FormBody`. */
const pascal = (key: string) =>
	key
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("")

/**
 * `value` with every `$ref` to a component renamed `<prefix><Name>`, every operationId `<key>.<id>` and every
 * `x-invalidate` target's path under `/<key>`.
 */
function prefixed(value: unknown, key: string, prefix: string): unknown {
	if (Array.isArray(value)) return value.map((item) => prefixed(item, key, prefix))
	if (value === null || typeof value !== "object") return value
	return Object.fromEntries(
		Object.entries(value).map(([name, item]) => {
			if (name === "$ref" && typeof item === "string")
				return [name, item.replace(/^(#\/components\/[^/]+\/)/, `$1${prefix}`)]
			if (name === "operationId" && typeof item === "string") return [name, `${key}.${item}`]
			if (name === "x-invalidate" && Array.isArray(item))
				return [
					name,
					item.map((target: unknown) => (typeof target === "string" ? target.replace(" /", ` /${key}/`) : target)),
				]
			return [name, prefixed(item, key, prefix)]
		}),
	)
}

/** `entries` as one object, throwing on a repeated name. */
function claimed(entries: readonly (readonly [string, unknown])[], what: string): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [name, value] of entries) {
		if (name in out) throw new Error(`merged: ${what} ${name} is claimed twice`)
		out[name] = value
	}
	return out
}

/**
 * `sources` as one document, each under its key: its paths under `/<key>`, its operationIds `<key>.<id>` (so
 * `IR.tree` nests them under the `<key>` namespace) and its components `<Key><Name>`, every `$ref` and
 * `x-invalidate` target rewritten to match; the first source's `servers`. Deterministic: one compile serves
 * every merged spec (Fb5, a4673b6e42).
 */
export function merged(sources: Readonly<Record<string, Json>>): Json {
	const all = Object.entries(sources).map(([key, source]) => [key, prefixed(source, key, pascal(key)) as Json] as const)
	const paths = all.flatMap(([key, source]) =>
		Object.entries((source.paths ?? {}) as Json).map(([path, item]) => [`/${key}${path}`, item] as const),
	)
	const sections = [...new Set(all.flatMap(([, source]) => Object.keys((source.components ?? {}) as Json)))].sort()
	const components = sections.map((section) => {
		const named = all.flatMap(([key, source]) =>
			Object.entries(((source.components ?? {}) as Record<string, Json>)[section] ?? {}).map(
				([name, value]) => [`${pascal(key)}${name}`, value] as const,
			),
		)
		return [section, claimed(named, `component ${section}`)] as const
	})
	const servers = Object.values(sources)[0]?.servers
	return {
		components: Object.fromEntries(components),
		info: { title: "Fixtures", version: "1" },
		openapi: "3.1.0",
		paths: claimed(paths, "path"),
		...(servers === undefined ? {} : { servers }),
	}
}

/** a4673b6e42's nine v0 fixtures as one document. */
function fixtures(): Json {
	return merged({
		crud,
		sse,
		ws,
		invalidation,
		"form-body": formBody,
		"error-keys": errorKeys,
		realtime,
		"realtime-sse": realtimeSse,
		"realtime-longpoll": realtimeLongpoll,
	})
}

/** Every crate a default run compiles: at most 16 (G17; tests/structure/rust-toolchain.test.ts). */
export const FIXTURES = {
	/** 60586125be's (and Go's 4eba1d1639's) adversarial corpus, both modes: every hostile name a Rust identifier (phase f) */
	adversarial: { document: adversarialCorpus },
	"adversarial-safe": { document: adversarialCorpus, options: { throwOnError: false } },
	/** the compile cache's self-test (Fb8): a dependency-free crate at the floor's `rust-version`, its lock as cargo writes it */
	cache: {
		files: {
			"Cargo.lock":
				'# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n\n[[package]]\nname = "cache-probe"\nversion = "0.1.0"\n',
			"Cargo.toml": '[package]\nname = "cache-probe"\nversion = "0.1.0"\nedition = "2024"\nrust-version = "1.85"\n',
			"src/lib.rs": "pub fn one() -> u8 {\n    1\n}\n",
		},
	},
	/** the same, stable only since 1.86 (`Vec::pop_if`): the floor legs prove they can fail */
	canary: {
		files: {
			"Cargo.lock":
				'# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n\n[[package]]\nname = "msrv-canary"\nversion = "0.1.0"\n',
			"Cargo.toml": '[package]\nname = "msrv-canary"\nversion = "0.1.0"\nedition = "2024"\nrust-version = "1.85"\n',
			"src/lib.rs": "pub fn last_even(v: &mut Vec<u32>) -> Option<u32> {\n    v.pop_if(|x| *x % 2 == 0)\n}\n",
		},
	},
	/** the declared error keys (G6/G7): colliding idents, an envelope's enum, `<Key>Data` schemas (contract 19 §4.3) */
	errors: { document: errors },
	fixtures: { document: fixtures },
	"fixtures-safe": { document: fixtures, options: { throwOnError: false } },
	/** the HTTP runtime's document (contract 19 §4.3): request build, auth, hooks, answers, stale marks, binary */
	http: { document: http },
	"http-safe": { document: http, options: { throwOnError: false } },
	/** the realtime connections (contract 20 §4.3): a typed feed, and one declaring every stream field's name */
	realtime: { document: streams.realtime },
	/** a relative first server: an empty `base_url` is `Error::Config` */
	relative: { document: relative },
	/** the event streams (contract 20 §4.3): typed with headers, string, a POST body, a path param */
	sse: { document: streams.sse },
	/** every compile rewrites the lock's root (`acme-rs`) and runs it under `--locked` */
	surface: { document: surface, options: { crateName: "acme-rs" } },
	types: { document: types },
	/** the WebSockets (contract 20 §4.3): a WebSocket-only crate, no realtime files */
	ws: { document: streams.ws },
} as const satisfies Record<string, RustFixture>

export type FixtureKey = keyof typeof FIXTURES
