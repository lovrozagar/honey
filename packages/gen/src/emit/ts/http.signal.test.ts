import { afterEach, describe, expect, it, vi } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, any>

const BASE = "https://api.test"
const OK = { 200: { content: { "application/json": { schema: {} } }, description: "" } }
const ITEMS = {
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths: { "/items": { get: { operationId: "items.list", responses: OK } } },
}

/** The emitted `TestSDK` over ITEMS, built with `config` against BASE. */
async function sdkFor(config: Json): Promise<any> {
	const { TestSDK } = await emittedSdk(ITEMS)
	return new (TestSDK as new (config: Json) => unknown)({ baseURL: BASE, ...config })
}

/** The emitted app front's client, built with `config` against BASE. */
async function appFor(config: Json): Promise<any> {
	const { createClient } = await emittedApp()
	return (createClient as (config: Json) => unknown)({ baseURL: BASE, ...config })
}

/** A recording fetch that never answers, and rejects with its signal's reason once that aborts. */
function hangingFetch() {
	return recordingFetch(
		(request) =>
			new Promise<Response>((_resolve, reject) => {
				request.signal.addEventListener("abort", () => reject(request.signal.reason))
			}),
	)
}

/** Wait, without timers, until `calls` holds `n` requests. */
async function sent(calls: readonly Request[], n: number): Promise<void> {
	for (let turn = 0; turn < 1000 && calls.length < n; turn++) await new Promise((resolve) => setImmediate(resolve))
	expect(calls).toHaveLength(n)
}

/** Spies on the global timers the runtime sets and clears. */
function spyTimers() {
	return { clear: vi.spyOn(globalThis, "clearTimeout"), set: vi.spyOn(globalThis, "setTimeout") }
}

/** The handles of the timers `set` was asked to set for `ms`. */
function timersFor(set: any, ms: number): unknown[] {
	return set.mock.calls.flatMap((args: unknown[], i: number) => (args[1] === ms ? [set.mock.results[i]?.value] : []))
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("config timeout", () => {
	// v0: a1ec69a992
	it("aborts a request that outlasts it", async () => {
		const { calls, fetch } = hangingFetch()
		await expect((await sdkFor({ fetch, timeout: 20 })).items.list()).rejects.toThrow()
		expect(calls[0]?.signal.aborted).toBe(true)
	})

	// v0: 0133924867
	it("lets a response within it resolve normally", async () => {
		const { fetch } = recordingFetch(() => Response.json({ id: "u1" }))
		expect(await (await sdkFor({ fetch, throwOnError: true, timeout: 5_000 })).items.list({})).toEqual({ id: "u1" })
	})

	// v0: 14270e4b01
	it("clears every timer it sets once the request is done", async () => {
		const { clear, set } = spyTimers()
		const sdk = await sdkFor({ fetch: recordingFetch().fetch, timeout: 30_000 })
		for (let i = 0; i < 10; i++) await sdk.items.list()
		const timers = timersFor(set, 30_000)
		expect([timers.length, timers.every((timer) => clear.mock.calls.some(([handle]) => handle === timer))]).toEqual([
			10,
			true,
		])
	})

	// v0: f95827cf3f
	it("without a timeout or a signal, the runtime sets no timer", async () => {
		const { set } = spyTimers()
		await (await sdkFor({ fetch: recordingFetch().fetch })).items.list()
		expect(set).not.toHaveBeenCalled()
	})
})

describe("per-call signal", () => {
	// v0: be205e6444
	it("aborting it aborts the request with its reason", async () => {
		const { calls, fetch } = hangingFetch()
		const ctrl = new AbortController()
		const call = (await sdkFor({ fetch })).items.list({ signal: ctrl.signal })
		await sent(calls, 1)
		const reason = new Error("user cancelled")
		ctrl.abort(reason)
		await expect(call).rejects.toBe(reason)
	})

	// v0: bd475181a6
	it("without a timeout, reaches fetch with no timer set", async () => {
		const { set } = spyTimers()
		const { calls, fetch } = hangingFetch()
		const ctrl = new AbortController()
		const call = (await sdkFor({ fetch })).items.list({ signal: ctrl.signal })
		await sent(calls, 1)
		ctrl.abort(new Error("stop"))
		await expect(call).rejects.toThrow("stop")
		expect([calls[0]?.signal.aborted, set.mock.calls.length]).toEqual([true, 0])
	})

	// v0: 0db33ecd26
	it("aborting it under a config timeout rejects with its reason and clears the timer", async () => {
		const { clear, set } = spyTimers()
		const { calls, fetch } = hangingFetch()
		const ctrl = new AbortController()
		const call = (await sdkFor({ fetch, timeout: 30_000 })).items.list({ signal: ctrl.signal })
		await sent(calls, 1)
		const reason = new Error("user cancelled")
		ctrl.abort(reason)
		await expect(call).rejects.toBe(reason)
		const [timer] = timersFor(set, 30_000)
		expect(clear.mock.calls.some(([handle]) => handle === timer)).toBe(true)
	})

	// v0: f8b6f5322a
	it("with a config timeout, the timer is cleared once the request resolves", async () => {
		const { clear, set } = spyTimers()
		const ctrl = new AbortController()
		await (await sdkFor({ fetch: recordingFetch().fetch, timeout: 30_000 })).items.list({ signal: ctrl.signal })
		const timers = timersFor(set, 30_000)
		expect([timers.length, clear.mock.calls.some(([handle]) => handle === timers[0])]).toEqual([1, true])
	})
})

describe("dispose()", () => {
	// v0: 54bf8bd01c
	it("aborts calls in flight and rejects later calls without fetching", async () => {
		const { calls, fetch } = hangingFetch()
		const sdk = await sdkFor({ fetch })
		const inFlight = sdk.items.list()
		await sent(calls, 1)
		sdk.dispose()
		await expect(inFlight).rejects.toBeDefined()
		await expect(sdk.items.list()).rejects.toBeDefined()
		expect(calls).toHaveLength(1)
	})
})

describe("app front: signal and timeout", () => {
	// v0: 336da90474
	it("a call with a user signal under a config timeout resolves normally", async () => {
		const { fetch } = recordingFetch(() => Response.json("ok"))
		const api = await appFor({ fetch, throwOnError: true, timeout: 5_000 })
		expect(await api.get("/health", { signal: new AbortController().signal })).toBe("ok")
	})

	// v0: 89976b6112
	it("an already-aborted user signal rejects the call before any fetch", async () => {
		const { calls, fetch } = recordingFetch()
		const api = await appFor({ fetch, timeout: 30_000 })
		await expect(api.get("/health", { signal: AbortSignal.abort(new Error("gone")) })).rejects.toThrow("gone")
		expect(calls).toHaveLength(0)
	})

	// v0: a664ad2b87
	it("a timeout rejects even in result mode", async () => {
		const { fetch } = hangingFetch()
		await expect((await appFor({ fetch, timeout: 20 })).get("/slow")).rejects.toThrow()
	})
})
