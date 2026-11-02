/**
 * A generated SDK ships only the runtime its operations use: no SSE code without an event stream, no WebSocket code
 * without a WebSocket or realtime operation, no realtime code without a realtime one. The app client, which cannot
 * know its routes' transports, ships the whole runtime.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"
import { REPO } from "../shared/__fixtures__/docs-blocks.ts"
import { emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"
import { generateAppClient } from "./app-client.ts"
import { generateSdk } from "./sdk.ts"

const GEN = join(REPO, "packages/gen")
const TSC = join(REPO, "node_modules/typescript/bin/tsc")

const JSON_OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const SSE_OK = { 200: { content: { "text/event-stream": { schema: { type: "string" } } }, description: "events" } }

const HEALTH = { "/health": { get: { operationId: "health", responses: JSON_OK } } }
const EVENTS = { "/events": { get: { operationId: "events", responses: SSE_OK } } }
const SOCKET = { "/socket": { get: { operationId: "socket", responses: {}, "x-websocket": true } } }
const FEED = { "/feed": { get: { operationId: "feed", responses: {}, "x-realtime": true } } }

const doc = (paths: Record<string, unknown>) => ({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths })

type Mix = { readonly realtime: boolean; readonly sse: boolean; readonly ws: boolean }

/* each document, and what its runtime must carry: realtime dials over SSE and WebSocket, so it ships both */
const MIXES: readonly (readonly [string, Record<string, unknown>, Mix])[] = [
	["plain HTTP", doc(HEALTH), { realtime: false, sse: false, ws: false }],
	["an event stream", doc({ ...HEALTH, ...EVENTS }), { realtime: false, sse: true, ws: false }],
	["a WebSocket", doc({ ...HEALTH, ...SOCKET }), { realtime: false, sse: false, ws: true }],
	[
		"an event stream and a WebSocket",
		doc({ ...HEALTH, ...EVENTS, ...SOCKET }),
		{ realtime: false, sse: true, ws: true },
	],
	["a realtime operation", doc({ ...HEALTH, ...FEED }), { realtime: true, sse: true, ws: true }],
]

/* what each feature puts in the runtime and in the index a consumer imports */
const RUNTIME_MARKS = {
	realtime: [/^export class Resumable\b/m, /^export function realtimeConnection\(/m],
	sse: [/^export async function\* parseSSEStream\(/m],
	ws: [/^export function createTypedWebSocket\(/m],
} as const
const INDEX_NAMES = {
	realtime: ["createResumableConnection", "RealtimeError", "ResumableConnection", "Transport"],
	sse: ["parseSSEStream", "SSEEvent"],
	ws: ["TypedWebSocket"],
} as const

const FEATURES = ["realtime", "sse", "ws"] as const

/** The SDK's files for `document`, by role. */
function sdkFiles(document: Record<string, unknown>) {
	const { files, stem } = generateSdk(document, { name: "Api", stem: "api" })
	return {
		files,
		index: files[`${stem}.index.gen.ts`] as string,
		runtime: files[`${stem}.runtime.gen.ts`] as string,
	}
}

/** The names an index re-exports, values and types alike. */
const exportedNames = (index: string): string[] =>
	[...index.matchAll(/^export (?:type )?\{([^}]*)\}/gm)].flatMap((m) =>
		(m[1] as string).split(",").map((n) => n.trim()),
	)

/* inside gen, so @types/node resolves from the workspace */
mkdirSync(join(GEN, ".tmp"), { recursive: true })
const scratch = mkdtempSync(join(GEN, ".tmp/runtime-features-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

/** tsc's errors for the SDK `files`, every strictness flag the packaging leg uses on. */
function typeErrors(files: Readonly<Record<string, string>>): string[] {
	const dir = mkdtempSync(join(scratch, "sdk-"))
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
	const compilerOptions = {
		exactOptionalPropertyTypes: true,
		lib: ["ESNext", "DOM"],
		module: "ESNext",
		moduleResolution: "bundler",
		noEmit: true,
		noImplicitOverride: true,
		noPropertyAccessFromIndexSignature: true,
		noUncheckedIndexedAccess: true,
		skipLibCheck: true,
		strict: true,
		target: "ESNext",
		types: [],
	}
	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions, files: Object.keys(files) }))
	const out = spawnSync("node", [TSC, "-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" }).stdout
	return out.split("\n").filter((line) => / error TS\d+/.test(line))
}

describe("the runtime a generated SDK ships", () => {
	it.each(MIXES)("for %s carries exactly the transports its operations use", (_, document, mix) => {
		const { runtime } = sdkFiles(document)
		const carried = Object.fromEntries(
			FEATURES.map((feature) => [feature, RUNTIME_MARKS[feature].map((mark) => mark.test(runtime))]),
		)
		expect(carried).toEqual(Object.fromEntries(FEATURES.map((f) => [f, RUNTIME_MARKS[f].map(() => mix[f])])))
	})

	it.each(MIXES)("for %s exports from its index only the names that ship", (_, document, mix) => {
		const names = new Set(exportedNames(sdkFiles(document).index))
		const exported = Object.fromEntries(FEATURES.map((f) => [f, INDEX_NAMES[f].map((name) => names.has(name))]))
		expect(exported).toEqual(Object.fromEntries(FEATURES.map((f) => [f, INDEX_NAMES[f].map(() => mix[f])])))
	})

	it.each(MIXES)("for %s type-checks under every strictness flag", { timeout: SPAWN_TIMEOUT }, (_, document) => {
		expect(typeErrors(sdkFiles(document).files)).toEqual([])
	})

	it("answers a plain HTTP call from the smallest runtime", async () => {
		const { fetch, calls } = recordingFetch(() => Response.json({ ok: true }))
		const sdk = await emittedSdk(doc(HEALTH), { name: "Api", stem: "api" })
		const Api = sdk.Api as new (config: object) => { health(): Promise<unknown> }
		expect(await new Api({ baseURL: "https://api.test", fetch }).health()).toEqual({ ok: true })
		expect(calls.map((request) => `${request.method} ${request.url}`)).toEqual(["GET https://api.test/health"])
	})
})

describe("the runtime the app client ships", () => {
	it("carries every transport, since an app's routes are not known to it", () => {
		const runtime = generateAppClient().files["client.runtime.gen.ts"] as string
		expect(FEATURES.flatMap((f) => RUNTIME_MARKS[f].map((mark) => mark.test(runtime)))).not.toContain(false)
	})
})
