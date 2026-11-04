/**
 * A generated SDK ships only the runtime its operations use: no SSE code without an event stream, no WebSocket code
 * without a WebSocket or realtime operation, no realtime code without a realtime one. The app client, which cannot
 * know its routes' transports, ships the whole runtime. Webhook verification is no part of the runtime: a document
 * with Standard Webhooks events gets it in a file of its own, which imports nothing a receiver would bundle.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { withPinnedBun } from "../../gen/__fixtures__/pinned-bun.ts"
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

const doc = (paths: Record<string, unknown>, webhooks?: Record<string, unknown>) => ({
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths,
	...(webhooks && { webhooks }),
})

/** A Standard Webhooks event `type` whose data is `{ [field]: string }`, as core documents it. */
const event = (type: string, field: string) => ({
	post: {
		"x-honey-webhook": "standard-webhooks",
		requestBody: {
			content: {
				"application/json": {
					schema: {
						properties: {
							data: { properties: { [field]: { type: "string" } }, required: [field], type: "object" },
							timestamp: { format: "date-time", type: "string" },
							type: { const: type },
						},
						required: ["type", "timestamp", "data"],
						type: "object",
					},
				},
			},
			required: true,
		},
		responses: { "2XX": { description: "Received" } },
	},
})
const UNMARKED = { ping: { post: { responses: { 200: { description: "ok" } } } } }
const EVENTS_HOOKS = { "order.paid": event("order.paid", "orderId"), "user.created": event("user.created", "email") }

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
function sdkFiles(document: Record<string, unknown>, name = "Api") {
	const { files, stem } = generateSdk(document, { name, stem: "api" })
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

	/* `SDK` is honey-clients' default name, and `SDKConfig` is also the runtime config type the types file imports */
	it.each([
		["a plain document", doc(HEALTH)],
		["a document with events", doc(HEALTH, EVENTS_HOOKS)],
	])("named SDK, the CLI's default, for %s type-checks", { timeout: SPAWN_TIMEOUT }, (_, document) => {
		expect(typeErrors(sdkFiles(document, "SDK").files)).toEqual([])
	})

	it("answers a plain HTTP call from the smallest runtime", async () => {
		const { fetch, calls } = recordingFetch(() => Response.json({ ok: true }))
		const sdk = await emittedSdk(doc(HEALTH), { name: "Api", stem: "api" })
		const Api = sdk.Api as new (config: object) => { health(): Promise<unknown> }
		expect(await new Api({ baseURL: "https://api.test", fetch }).health()).toEqual({ ok: true })
		expect(calls.map((request) => `${request.method} ${request.url}`)).toEqual(["GET https://api.test/health"])
	})
})

/** A receiver that narrows on `known`, then on `type`, every declared event handled or `never` fails to compile. */
const RECEIVER = `import { type WebhookEvent, verifyWebhook, WebhookVerificationError } from "./api.webhook.gen"

export async function receive(request: Request, secret: string): Promise<Response> {
	try {
		const event: WebhookEvent = await verifyWebhook(await request.text(), request.headers, secret)
		if (!event.known) return new Response(null, { status: 204 })
		switch (event.type) {
			case "order.paid":
				return Response.json({ order: event.data.orderId.toUpperCase() })
			case "user.created":
				return Response.json({ email: event.data.email.toLowerCase() })
			default: {
				const unhandled: never = event
				return unhandled
			}
		}
	} catch (e) {
		if (e instanceof WebhookVerificationError) return new Response(null, { status: 401 })
		throw e
	}
}
`

describe("a receiver of the SDK's webhook events", () => {
	it("gets a webhooks file of its own, the runtime and the index left as they are without events", () => {
		const plain = sdkFiles(doc(HEALTH, UNMARKED))
		const events = sdkFiles(doc(HEALTH, EVENTS_HOOKS))
		const imports = [...(events.files["api.webhook.gen.ts"] ?? "").matchAll(/^import .*$/gm)].map((m) => m[0])
		expect([
			events.runtime === plain.runtime,
			events.index === plain.index,
			"api.webhook.gen.ts" in plain.files,
			imports,
		]).toEqual([true, true, false, ['import type { WebhookEvent } from "./api.types.gen.js"']])
	})

	/* minified, the receiver's bytes are the verifier's: 2,406 at plan 37, with room for one small fix */
	it(
		"bundles alone, no client in it, where a receiver that also exports the index's client carries it",
		{ timeout: SPAWN_TIMEOUT },
		(ctx) => {
			const bun = withPinnedBun()
			if (bun === undefined) return ctx.skip()
			const dir = mkdtempSync(join(scratch, "receiver-"))
			const files = { ...sdkFiles(doc(HEALTH, EVENTS_HOOKS)).files, "receiver.ts": RECEIVER }
			const indexed = `${RECEIVER.replace('"./api.webhook.gen"', '"./api.index.gen"').replace(
				"type WebhookEvent, verifyWebhook, WebhookVerificationError",
				"type WebhookEvent, isClientError as verifyWebhook, ClientError as WebhookVerificationError",
			)}\nexport { Api } from "./api.index.gen"\n`
			for (const [name, text] of Object.entries({ ...files, "indexed.ts": indexed }))
				writeFileSync(join(dir, name), text)
			const bundle = (entry: string) => {
				const out = spawnSync(bun, ["build", entry, "--minify", "--target", "browser"], { cwd: dir, encoding: "utf8" })
				expect(out.status, out.stderr).toBe(0)
				return out.stdout
			}
			const alone = bundle("receiver.ts")
			/* a header name only the client's cross-origin handling holds */
			const CLIENT = '"accept-language"'
			expect([alone.includes(CLIENT), alone.length <= 2_560, bundle("indexed.ts").includes(CLIENT)]).toEqual([
				false,
				true,
				true,
			])
		},
	)

	it("narrows each declared event's data under every strictness flag", { timeout: SPAWN_TIMEOUT }, () => {
		expect(typeErrors({ ...sdkFiles(doc(HEALTH, EVENTS_HOOKS)).files, "receiver.ts": RECEIVER })).toEqual([])
	})

	it("fails to compile once the document declares an event it does not handle", { timeout: SPAWN_TIMEOUT }, () => {
		const grown = doc(HEALTH, { ...EVENTS_HOOKS, "user.deleted": event("user.deleted", "reason") })
		const errors = typeErrors({ ...sdkFiles(grown).files, "receiver.ts": RECEIVER })
		expect(errors).toHaveLength(1)
		expect(errors[0]).toMatch(
			/^receiver\.ts\(\d+,\d+\): error TS2322: Type 'UserDeletedWebhookEvent' is not assignable to type 'never'/,
		)
	})
})

describe("the runtime the app client ships", () => {
	it("carries every transport, since an app's routes are not known to it", () => {
		const runtime = generateAppClient().files["client.runtime.gen.ts"] as string
		expect(FEATURES.flatMap((f) => RUNTIME_MARKS[f].map((mark) => mark.test(runtime)))).not.toContain(false)
	})
})
