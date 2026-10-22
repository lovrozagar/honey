/**
 * The Java test driver's protocol legs (bit 16 phase c1, C2, C3): the emitter's call plans name one plan per operation
 * by id; a plain call's script traces its elapsed time, its hooks, its log and its auth refreshes; the driver binds
 * arguments through the operation's builder, a model argument through the SDK's mapper, and a discriminated answer
 * through the same mapper; a safe-mode failure is the method's result, not a throw; a timeout and a status error are
 * observed as the C# driver observes them; a refused connection is the call's error, aimed at `REFUSED_URL`; and a bad
 * script is refused before any call is sent. Gated on the pinned JDK and Gradle (withJava).
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { REFUSED_URL, served } from "../shared/__fixtures__/recording-server.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { javaCallPlans } from "./sdk.ts"

/** Whether the pinned JDK and Gradle are here: a missing pin fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()

/** Every operationId a document names, sorted. */
const operationIdsOf = (document: Readonly<Record<string, unknown>>): string[] => {
	const paths = document.paths as Record<string, Record<string, { readonly operationId?: string }>>
	return Object.values(paths)
		.flatMap((item) => Object.values(item))
		.flatMap((op) => (op.operationId === undefined ? [] : [op.operationId]))
		.sort()
}

/** The `http` document's `members.get`: path params out of path order, a query array and a bracketed query key. */
const MEMBERS: Call = {
	operation: "members.get",
	params: { "user-id": "m?1", org: "a/b c" },
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
	search: { ids: ["a", "b"], "page[size]": 5 },
}

/** The `http` document's `orders.create`: a JSON body that is the model argument, bound through the SDK's mapper. */
const ORDER: Call = {
	body: { kind: "json", value: { sku: "a-1" } },
	operation: "orders.create",
	route: { method: "POST", path: "/orders" },
}

/** The `http` document's `shapes.get`: a discriminated union answer, decoded through the SDK's mapper. */
const SHAPE: Call = { operation: "shapes.get", route: { method: "GET", path: "/shape" } }

/** The merged `fixtures` document's `crud.users.get` (crud.json's `users.get`), sent through the safe-mode SDK. */
const USER: Call = {
	operation: "crud.users.get",
	params: { id: "u1" },
	route: { method: "GET", path: "/crud/users/{id}" },
}

describe("javaCallPlans: one call plan per operation, by operationId", () => {
	it("keys the http document's plans by every operationId it names", () => {
		const document = FIXTURES.http.document()
		expect(Object.keys(javaCallPlans(document, {})).sort()).toEqual(operationIdsOf(document))
	})
})

describe.skipIf(!JAVA)("the Java test driver binds arguments and decodes answers through the SDK", () => {
	it("binds a call's path, query and auth through the builder and sends it by its route", async () => {
		const sdk = drivenJavaSdk("http")
		const setup = { auth: { kind: "bearer", token: "tok" } } as const
		const [run, hops] = await served([{ json: { id: "m1", name: "Ann" }, status: 200 }], async (server) => {
			const ran = await sdk.runCalls({ calls: [MEMBERS], setup }, { url: `${server.url}/v1` })
			return [ran, server.hops] as const
		})
		expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({
			observed: [{ data: { id: "m1", name: "Ann" }, kind: "data", status: 200 }] satisfies Observed[],
			status: 0,
		})
		expect(hops).toMatchObject([
			{
				headers: { authorization: "Bearer tok" },
				method: "GET",
				url: "/v1/orgs/a%2Fb%20c/users/m%3F1?ids=a&ids=b&page%5Bsize%5D=5",
			},
		])
	}, 120_000)

	it("binds a model argument through the SDK's mapper: the body the server gets is the model as the SDK writes it", async () => {
		const sdk = drivenJavaSdk("http")
		const [run, hops] = await served([{ json: { id: "o1" }, status: 201 }], async (server) => {
			const ran = await sdk.runCalls({ calls: [ORDER] }, { url: server.url })
			return [ran, server.hops] as const
		})
		expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({
			observed: [{ data: { id: "o1" }, kind: "data", status: 201 }] satisfies Observed[],
			status: 0,
		})
		expect(hops).toMatchObject([
			{ body: { contentType: "application/json", json: { sku: "a-1" } }, method: "POST", url: "/orders" },
		])
	}, 120_000)

	it("decodes a discriminated union answer through the SDK's mapper, as the data the caller reads", async () => {
		const sdk = drivenJavaSdk("http")
		const reply = { json: { kind: "circle", radius: 2 }, status: 200 } as const
		const run = await served([reply], (server) => sdk.runCalls({ calls: [SHAPE] }, { url: server.url }))
		expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({
			observed: [{ data: { kind: "circle", radius: 2 }, kind: "data", status: 200 }] satisfies Observed[],
			status: 0,
		})
	}, 120_000)
})

describe.skipIf(!JAVA)("the Java test driver observes answers, errors and timeouts", () => {
	it("observes the raw response, a status error with its body, and a timeout", async () => {
		const sdk = drivenJavaSdk("http")
		const replies = [
			{ json: { id: "m1", name: "Ann" }, status: 200 },
			{ json: { message: "no" }, status: 404 },
			{ json: { id: "m1", name: "Ann" }, status: 200, delayMs: 2_000 },
		] as const
		const calls: readonly Call[] = [{ ...MEMBERS, raw: true }, MEMBERS, { ...MEMBERS, timeoutMs: 150 }]
		const run = await served(replies, (server) => sdk.runCalls({ calls }, { url: server.url }))
		expect({ observed: run.observed, status: run.status }, run.stderr).toMatchObject({
			observed: [
				{ body: '{"id":"m1","name":"Ann"}', headers: { "content-type": "application/json" }, kind: "raw", status: 200 },
				{ body: { message: "no" }, errorKey: null, kind: "error", status: 404 },
				{ kind: "timeout" },
			],
			status: 0,
		})
	}, 120_000)
})

describe.skipIf(!JAVA)("the Java test driver traces scripted calls and safe mode", () => {
	it("traces a plain call under a script: its elapsed time, and no hook, log or auth refresh", async () => {
		const sdk = drivenJavaSdk("http")
		const script: Script = {}
		const [run, hops] = await served([{ json: { id: "o1" }, status: 201 }], async (server) => {
			const ran = await sdk.runCalls({ calls: [ORDER] }, { url: server.url }, { script })
			return [ran, server.hops] as const
		})
		expect({ hops: hops.length, status: run.status, stderr: run.stderr }, run.stderr).toEqual({
			hops: 1,
			status: 0,
			stderr: "",
		})
		expect(run.trace).toMatchObject({
			authExpired: 0,
			calls: [{ elapsedMs: expect.any(Number) }],
			hooks: [],
			log: [],
		})
		expect(run.trace?.calls[0]?.error).toBeUndefined()
	}, 120_000)

	it("traces a safe-mode failure as the method's result: Result.Err, not a throw", async () => {
		const sdk = drivenJavaSdk("fixtures-safe")
		const run = await served([{ json: { message: "no" }, status: 404 }], (server) =>
			sdk.runCalls({ calls: [USER] }, { url: server.url }, { script: {} }),
		)
		expect({ status: run.status, stderr: run.stderr }, run.stderr).toEqual({ status: 0, stderr: "" })
		expect(run.trace?.calls).toMatchObject([{ result: { ok: false, status: 404 } }])
	}, 120_000)
})

describe.skipIf(!JAVA)("the Java test driver refuses what it cannot send", () => {
	it("traces a refused connection as the call's error, aimed at REFUSED_URL", async () => {
		const sdk = drivenJavaSdk("http")
		const run = await sdk.runCalls({ calls: [MEMBERS] }, { url: REFUSED_URL }, { script: {} })
		expect({ status: run.status, error: run.trace?.calls[0]?.error }, run.stderr).toMatchObject({
			error: { canceled: false, via: "return" },
			status: 0,
		})
	}, 120_000)

	it("refuses a script with more calls than the cell before any call is sent", async () => {
		const sdk = drivenJavaSdk("http")
		const script: Script = { calls: [null, null] }
		const [run, hops] = await served([], async (server) => {
			const ran = await sdk.runCalls({ calls: [ORDER] }, { url: server.url }, { script })
			return [ran, server.hops] as const
		})
		expect({ hops: hops.length, observed: run.observed, status: run.status, stderr: run.stderr.trim() }).toEqual({
			hops: 0,
			observed: undefined,
			status: 1,
			stderr: "driver: script: 2 calls scripted for a cell of 1",
		})
	}, 120_000)
})
