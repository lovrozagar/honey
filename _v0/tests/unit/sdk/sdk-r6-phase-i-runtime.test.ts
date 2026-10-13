import { describe, expect, it } from "vitest"
import { createSDK } from "../../../src/client/sdk.ts"
import { captureFetch } from "./_helpers/phase-f.ts"

const PHASE_I_FIXED = true

/* ── service map fixture ── */

const serviceMap = {
	items: {
		list: { method: "GET", params: [], path: "/v1/items" },
	},
}

type ItemSDK = {
	items: {
		list: (input?: { search?: Record<string, unknown> }) => Promise<unknown>
	}
}

/* ═══════════════════════════════════════════════════════════════════
   #R6-24 — Date/Symbol in search params (reference createSDK)
   Layer A: invariants that hold before AND after (always GREEN)
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-24 search param serialization — Layer A invariants", () => {
	it("Layer A: string search param appears in URL as key=value", async () => {
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		await sdk.items.list({ search: { key: "value" } })

		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toContain("key=value")
	})

	it("Layer A: number search param appears in URL as n=42", async () => {
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		await sdk.items.list({ search: { n: 42 } })

		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toContain("n=42")
	})

	it("Layer A: null search param is omitted from URL", async () => {
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		await sdk.items.list({ search: { skip: null } })

		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).not.toContain("skip")
	})

	it("Layer A: undefined search param is omitted from URL", async () => {
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		await sdk.items.list({ search: { skip: undefined } })

		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).not.toContain("skip")
	})

	it("Layer A: array search param repeats key for each element (tags=a&tags=b)", async () => {
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		await sdk.items.list({ search: { tags: ["a", "b"] } })

		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toContain("tags=a")
		expect(calls[0]?.url).toContain("tags=b")
	})

	it("Layer A: boolean search param appears in URL as flag=true", async () => {
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		await sdk.items.list({ search: { flag: true } })

		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toContain("flag=true")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-24 — Date/Symbol bug witnesses
   Layer B: pre-fix behavior (GREEN now, SKIPPED when PHASE_I_FIXED=1)
   ═══════════════════════════════════════════════════════════════════ */

describe.skipIf(PHASE_I_FIXED)("#R6-24 Date/Symbol — Layer B bug witness", () => {
	it("Layer B pre-fix: Date search param produces locale-format string (NOT ISO 8601)", async () => {
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		const d = new Date("2026-01-01T00:00:00.000Z")
		await sdk.items.list({ search: { since: d } })

		expect(calls).toHaveLength(1)
		const url = calls[0]?.url
		/*
		 * String(new Date()) produces locale-dependent format — it will NOT contain
		 * the ISO 8601 substring "2026-01-01T00%3A00%3A00". The key must be present
		 * (Date serializes to *something* via String()), but NOT as ISO.
		 */
		expect(url).toContain("since=")
		expect(url).not.toContain("2026-01-01T00%3A00%3A00")
	})

	it("Layer B pre-fix: Symbol search param serializes to String(Symbol) form in URL (not omitted)", async () => {
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		/*
		 * String(Symbol("x")) does not throw — it returns "Symbol(x)".
		 * The bug is that the Symbol ends up in the URL as a visible string value
		 * rather than being omitted silently.
		 */
		const sym = Symbol("x")
		await sdk.items.list({ search: { tag: sym as unknown as string } })

		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toContain("tag=")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-24 — post-fix regression
   Layer B': asserts correct behavior (SKIPPED now, GREEN when PHASE_I_FIXED=1)
   ═══════════════════════════════════════════════════════════════════ */

describe.runIf(PHASE_I_FIXED)("#R6-24 Date/Symbol — Layer B' regression", () => {
	it("Layer B' post-fix: Date search param serializes to ISO 8601 (URL-encoded)", async () => {
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		const d = new Date("2026-01-01T00:00:00.000Z")
		await sdk.items.list({ search: { since: d } })

		expect(calls).toHaveLength(1)
		/* URL-encoded ISO: colons → %3A */
		expect(calls[0]?.url).toContain("since=2026-01-01T00%3A00%3A00.000Z")
	})

	it("Layer B' post-fix: Symbol search param is omitted from URL (no throw, no key present)", async () => {
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		const sym = Symbol("x")
		await sdk.items.list({ search: { tag: sym as unknown as string } })

		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).not.toContain("tag=")
	})
})
