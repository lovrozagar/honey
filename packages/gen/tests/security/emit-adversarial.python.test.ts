/**
 * The Python third of gen's adversarial suite (bit 14): the shared adversarial corpus's package ruff-clean after the
 * pass, mypy-clean under --strict at 3.11 and imported in both throwOnError modes, every hostile name a Python
 * identifier, every value a literal and no raw control code point in the source, and imported under PY_FLOOR; then
 * the emitted Python runtime's three guards answered on the wire on both clients (`AsyncSDK` and `SDK`), on the
 * driven SDKs `http*.test.ts` and `realtime.test.ts` already build (`http`, `realtime`): a cross-origin redirect hop
 * stripped (a caller's httpx2 client, a realtime event-stream dial and an http→https hop included), a path param
 * escaped or refused, and every on_log entry and error text free of path values, the query and the token. The gen
 * mutation harness reruns this file alone with each Python guard disabled, so a mutant's runtime is what is gated.
 */
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { PythonFixture } from "../../src/emit/python/__fixtures__/documents.ts"
import type { DrivenPythonSdk } from "../../src/emit/python/__fixtures__/driven.ts"
import { PY_FLOOR, withPython } from "../../src/emit/python/__fixtures__/python-env.ts"
import { CLEAN, pythonNames, ruffGate } from "../../src/emit/python/__fixtures__/ruff-gate.ts"
import type { Script } from "../../src/emit/shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../../src/emit/shared/__fixtures__/recording-server.ts"
import type { Call, Setup } from "../integration/conformance/matrix.ts"
import { guardNamed } from "../structure/mutation-harness.guards.ts"

/** Whether Python is here, and the floor interpreter: a missing one fails where it is required and skips elsewhere (python-env). */
const PY = withPython()
const FLOOR = withPython(PY_FLOOR)

const REPO = resolve(import.meta.dirname, "../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolve(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* imported after the mock: each reaches sdk.ts and so transport.ts, so a mutant's runtime is what is gated */
const { compiledPython } = (await import(
	resolve(REPO, "packages/gen/src/emit/python/__fixtures__/compiled.ts")
)) as typeof import("../../src/emit/python/__fixtures__/compiled.ts")
const { drivenPythonSdk } = (await import(
	resolve(REPO, "packages/gen/src/emit/python/__fixtures__/driven.ts")
)) as typeof import("../../src/emit/python/__fixtures__/driven.ts")
const { consume, seen } = (await import(
	resolve(REPO, "packages/gen/src/emit/python/__fixtures__/consumer.ts")
)) as typeof import("../../src/emit/python/__fixtures__/consumer.ts")
const { FIXTURES } = (await import(
	resolve(REPO, "packages/gen/src/emit/python/__fixtures__/documents.ts")
)) as typeof import("../../src/emit/python/__fixtures__/documents.ts")
const { generatePythonSdk } = (await import(
	resolve(REPO, "packages/gen/src/emit/python/sdk.ts")
)) as typeof import("../../src/emit/python/sdk.ts")

/* one client holds both styles, the normal methods and their `safe` mirror (bit 21 i2) */
const CORPUS = ["adversarial"] as const

/** The corpus package `key` as the emitter writes it. */
function emitted(key: (typeof CORPUS)[number]): Readonly<Record<string, string>> {
	const fixture: PythonFixture = FIXTURES[key]
	if (!("document" in fixture)) throw new Error(`${key} is not a document fixture`)
	return generatePythonSdk(fixture.document(), fixture.options).files
}

/* a code point no Python source may carry raw: NUL, BEL, the BOM, U+2028 and U+2029 */
const RAW = ["\u0000", "\u0007", "﻿", " ", " "]

describe.skipIf(!PY)("gen adversarial: the Python SDK emitter", () => {
	/* v0 byte-compiled, imported and ran plain mypy 3.11 in a tmpdir, skipping without mypy or httpx
	 * (polyglot-compile.test.ts:122-142); v1 gates the registry package with ruff (Fb9) and mypy --strict (Fb10)
	 * under the pins, and its floor (G10) */
	// v0: e8f9ebeb5f
	// v0: 4553f2db3f
	// v0: dcdad92ee2
	it("passes ruff and mypy --strict at 3.11 and imports, in both throwOnError modes, every hostile name a Python identifier, every value a literal and no raw control code point in the source", async () => {
		const modes = await Promise.all(
			CORPUS.map(async (key) => {
				const sdk = compiledPython(key)
				const files = emitted(key)
				const raw = pythonNames(files).filter((name) => RAW.some((point) => files[name]?.includes(point)))
				const gate = { imported: sdk.imported, key, mypy: sdk.mypy(), raw, ruff: await ruffGate(files) }
				const ruff = { ...CLEAN, reached: pythonNames(files), suppressed: [] }
				return { clean: { imported: true, key, mypy: [], raw: [], ruff }, gate, stderr: sdk.stderr }
			}),
		)
		expect(
			[modes.map((mode) => mode.gate), ({} as Record<string, unknown>).polluted, ({} as Record<string, unknown>).y],
			modes.map((mode) => mode.stderr).join(""),
		).toEqual([modes.map((mode) => mode.clean), undefined, undefined])
	}, 600_000)

	it.skipIf(!FLOOR)(
		"imports the corpus SDK under PY_FLOOR at the dependency floors",
		() => {
			const floor = compiledPython("adversarial", { python: "floor" })
			expect(floor.imported, floor.stderr).toBe(true)
		},
		600_000,
	)
})

const CLIENTS = ["async", "sync"] as const
type Client = (typeof CLIENTS)[number]

/** The driven SDKs the guard cases use, gated once per suite run (the mutant's runtime included): each must import. */
const driven = new Map<"http" | "realtime", DrivenPythonSdk>()
function guards(key: "http" | "realtime"): DrivenPythonSdk {
	const sdk = driven.get(key) ?? drivenPythonSdk(key)
	driven.set(key, sdk)
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

/** What a leg saw, and the stderr that explains it when it fails. */
type Seen<T> = { readonly seen: T; readonly stderr: string }

/** `run` on each client: what each saw, keyed by client, and every stderr. */
async function perClient<T>(run: (client: Client) => Promise<Seen<T>>): Promise<Seen<Record<Client, T>>> {
	const runs = await Promise.all(CLIENTS.map(run))
	const byClient = Object.fromEntries(CLIENTS.map((client, i) => [client, runs[i]?.seen])) as Record<Client, T>
	return { seen: byClient, stderr: runs.map((r) => r.stderr).join("") }
}

const BEARER: Setup["auth"] = { kind: "bearer", token: "s3cret" }
const HOP: Call = { operation: "hop.get", route: { method: "GET", path: "/hop" } }
/* a 307 to the other origin, then the landing */
const AWAY: Reply[] = [
	{ redirect: { origin: "alt", path: "/landing" }, status: 307 },
	{ json: {}, status: 200 },
]
/* the auth header, a cookie and a configured header, a redirect followed */
const CARRIED: Setup = { auth: BEARER, headers: { Cookie: "sid=1", "X-Api-Key": "k-1" }, redirect: "follow" }
/* a path param value, a query value and (by the setup) a token, on a success and then a 401 */
const MEMBER: Call = {
	operation: "members.get",
	params: { org: "p4th", "user-id": "u-1" },
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
	search: { ids: ["k3y"] },
}
const usersGet = (id: string): Call => ({
	operation: "users.get",
	params: { id },
	route: { method: "GET", path: "/users/{id}" },
})

/** The credentials CARRIED sets, as a hop carried them (null where it did not). */
const creds = (hop: RecordedHop | undefined) =>
	["authorization", "cookie", "x-api-key"].map((name) => hop?.headers[name] ?? null)

/** HOP sent on `client` with CARRIED through AWAY under `script`: the driver's status, where it landed and the credentials it landed with. */
async function landing(sdk: DrivenPythonSdk, client: Client, script?: Script): Promise<Seen<unknown[]>> {
	const { hops, run } = await served(AWAY, async (server) => ({
		hops: server.hops,
		run: await sdk.runCalls({ calls: [HOP], setup: CARRIED }, server, { client, script }),
	}))
	const hop = hops[1]
	return { seen: [run.status, `${hop?.origin} ${hop?.url}`, creds(hop)], stderr: run.stderr }
}

/* the realtime leg: one `feed.live` frame, a quick reconnect, every dial redirected to the other origin until it holds */
const FEED: Call = {
	operation: "feed.live",
	route: { method: "GET", path: "/feed" },
	search: { channel: "c" },
	take: 1,
}
const QUICK: Script = { calls: [{ realtime: { reconnectDelayMs: 10 } }] }
const TO_ALT: Reply = { redirect: { origin: "alt", path: "/feed?channel=c" }, status: 307 }
const HELD: Reply = { sse: { end: "hold", steps: ['id: 1\ndata: {"n":1,"reconnect_token":"rt-1"}\n\n'] }, status: 200 }
/** which dial a hop is: a WebSocket upgrade, an event stream, else a poll */
const dialOf = (hop: RecordedHop) =>
	hop.headers.upgrade ? "upgrade" : hop.headers.accept === "text/event-stream" ? "sse" : "poll"
const SENT = JSON.stringify(["Bearer s3cret", "sid=1", "k-1"])

/* the redirect follow over an http→https hop, in process: the recording server has no TLS */
const HTTPS_HOP = `import importlib

redirect = importlib.import_module(f"{sdk.__name__}._honey.redirect")
sent = {"Authorization": "Bearer s3cret", "Cookie": "sid=1", "X-Api-Key": "k-1", "Accept": "application/json"}
hop = redirect.Hop("GET", "http://h.test/a", sent, None)
for policy in ("same-origin", "follow"):
    nxt = redirect.follow(hop, 307, "https://h.test/b", policy, "http://h.test/a")
    note(f"{policy} {None if nxt is None else [nxt.cross, sorted(nxt.headers)]}")`

/** `users.get` with `../admin`, `a/b` and `..` on `client` under base `/v1`: each call's error type and every URL sent. */
const pathParams = (sdk: DrivenPythonSdk, client: Client) =>
	served([], async (server) => {
		const cell = { calls: [usersGet("../admin"), usersGet("a/b"), usersGet("..")] }
		const run = await sdk.runCalls(cell, { url: `${server.url}/v1` }, { client, script: {} })
		const errors = run.trace?.calls.map((c) => c.error?.type ?? null)
		return { seen: { errors, urls: server.hops.map((h) => h.url) }, stderr: run.stderr }
	})

/* a success, then a 401 */
const ANSWERS: Reply[] = [
	{ json: { id: "m-1", name: "n" }, status: 200 },
	{ json: { message: "no access" }, status: 401 },
]

/** MEMBER twice on `client` under BEARER with on_log on: the events logged, the leak words seen, the 401. */
async function redaction(sdk: DrivenPythonSdk, client: Client) {
	const run = await served(ANSWERS, (server) =>
		sdk.runCalls({ calls: [MEMBER, MEMBER], setup: { auth: BEARER } }, server, { client, script: { log: true } }),
	)
	const log = run.trace?.log ?? []
	/* the error record carries its str() and repr(), so a value in either is seen */
	const text = JSON.stringify([log, run.trace?.calls.map((c) => c.error)])
	/* events and status keep it from passing vacuously: an empty log or a missing 401 fails it clean */
	const found = {
		events: log.map((e) => e.event),
		leaks: ["s3cret", "k3y", "p4th"].filter((word) => text.includes(word)),
		status: run.trace?.calls[1]?.error?.status,
	}
	return { seen: found, stderr: run.stderr }
}

describe.skipIf(!PY)("gen adversarial: the emitted Python runtime", () => {
	it("drops the auth header, cookies and configured headers on a cross-origin redirect hop on both clients, a caller's httpx2 client included", async () => {
		const sdk = guards("http")
		const runs = await perClient(async (client) => {
			const both = await Promise.all([landing(sdk, client), landing(sdk, client, { config: { httpClient: true } })])
			return { seen: both.map((r) => r.seen), stderr: both.map((r) => r.stderr).join("") }
		})
		const landed = [0, "alt /landing", [null, null, null]]
		expect(runs.seen, runs.stderr).toEqual({ async: [landed, landed], sync: [landed, landed] })
	}, 600_000)

	it("follows no redirect on a realtime upgrade and strips the event-stream dial's cross-origin hop", async () => {
		const sdk = guards("realtime")
		const { hops, run } = await served([TO_ALT, TO_ALT, HELD], async (server) => {
			const ran = await sdk.runCalls(
				{ calls: [FEED], setup: CARRIED },
				{ url: server.url },
				{ client: "async", script: QUICK },
			)
			return { hops: [...server.hops], run: ran }
		})
		expect(
			{ dials: hops.map((h) => `${h.origin} ${dialOf(h)} ${JSON.stringify(creds(h))}`), observed: run.observed },
			run.stderr,
		).toEqual({
			dials: [`primary upgrade ${SENT}`, `primary sse ${SENT}`, "alt sse [null,null,null]"],
			observed: [{ frames: [{ n: 1, reconnect_token: "rt-1" }], kind: "frames" }],
		})
	}, 600_000)

	it("treats an http→https hop as cross-origin: refused under same-origin, stripped under follow", async () => {
		const run = await consume("http", "https-hop", { body: HTTPS_HOP })
		expect(seen(run), run.stderr).toEqual({ out: ["same-origin None", "follow [True, ['Accept']]"], ran: true })
	}, 600_000)

	it("never lets a path param add, drop or climb a segment, on either client", async () => {
		const sdk = guards("http")
		const runs = await perClient((client) => pathParams(sdk, client))
		const refused = { errors: [null, null, "PathParamError"], urls: ["/v1/users/..%2Fadmin", "/v1/users/a%2Fb"] }
		expect(runs.seen, runs.stderr).toEqual({ async: refused, sync: refused })
	}, 600_000)

	it("keeps path values, the query and the token out of every on_log entry and error text, on either client", async () => {
		const sdk = guards("http")
		const runs = await perClient((client) => redaction(sdk, client))
		const kept = {
			events: ["request_start", "response_received", "request_start", "response_received", "error"],
			leaks: [],
			status: 401,
		}
		expect(runs.seen, runs.stderr).toEqual({ async: kept, sync: kept })
	}, 600_000)
})
