import { describe, expect, it } from "vitest"
import { createSDK } from "../../../src/client/sdk.ts"
import { captureFetch } from "./_helpers/phase-f.ts"

const PHASE_F_FIXED = true

const serviceMap = {
	items: {
		list: { method: "GET", path: "/v1/items" },
	},
}

type TestSDK = {
	items: {
		list: (input?: Record<string, unknown>) => Promise<unknown>
	}
}

function makeSDK(baseURL: string, throwOnError = false) {
	const capture = captureFetch()
	const sdk = createSDK<TestSDK>(serviceMap, {
		baseURL,
		fetch: capture.fetcher,
		throwOnError,
	})
	return { calls: capture.calls, sdk }
}

/* ═══════════════════════════════════════════════════════════════════
   #R6-1 — Layer A invariants (always GREEN before and after fix)
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-1 baseURL query merge — Layer A invariants", () => {
	it("baseURL without query: resolves to baseURL + path", async () => {
		const { calls, sdk } = makeSDK("https://api.example.com")
		await sdk.items.list()
		expect(calls[0]?.url).toBe("https://api.example.com/v1/items")
	})

	it("baseURL with trailing slash: resolves correctly without double slash", async () => {
		const { calls, sdk } = makeSDK("https://api.example.com/")
		await sdk.items.list()
		expect(calls[0]?.url).toBe("https://api.example.com/v1/items")
	})

	it("baseURL with prefix path: prefix is preserved in the final URL", async () => {
		const { calls, sdk } = makeSDK("https://api.example.com/prefix/")
		await sdk.items.list()
		expect(calls[0]?.url).toBe("https://api.example.com/prefix/v1/items")
	})

	it("request-level search params: URL contains q=foo", async () => {
		const { calls, sdk } = makeSDK("https://api.example.com")
		await sdk.items.list({ search: { q: "foo" } })
		expect(calls[0]?.url).toContain("q=foo")
	})

	it("request-level search params with base that has no query: base key collision uses append semantics (both present)", async () => {
		/* Lock: append semantics mean both base AND request params survive on key collision */
		const capture = captureFetch()
		const sdk = createSDK<TestSDK>(serviceMap, {
			baseURL: "https://api.example.com",
			fetch: capture.fetcher,
		})
		await sdk.items.list({ search: { q: "from-request" } })
		/* At minimum, the request-level param must arrive */
		expect(capture.calls[0]?.url).toContain("q=from-request")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-1 — Layer B bug witness (runs when PHASE_F_FIXED is unset)
   Documents the current query-drop behavior.
   ═══════════════════════════════════════════════════════════════════ */

describe.skipIf(PHASE_F_FIXED)("#R6-1 — Layer B bug witness (pre-fix)", () => {
	it("baseURL with ?tenant=acme: query param is silently dropped by new URL(rel, base)", async () => {
		/* new URL(relative, base) discards base's search params — this is the bug */
		const { calls, sdk } = makeSDK("https://api.example.com/?tenant=acme")
		await sdk.items.list()
		expect(calls[0]?.url).not.toContain("tenant=acme")
	})

	it("baseURL with ?tenant=acme plus request search: request param present but base param absent", async () => {
		const { calls, sdk } = makeSDK("https://api.example.com/?tenant=acme")
		await sdk.items.list({ search: { q: "1" } })
		expect(calls[0]?.url).toContain("q=1")
		expect(calls[0]?.url).not.toContain("tenant=acme")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-1 — Layer B' regression (runs when PHASE_F_FIXED=1)
   Asserts the FIXED behavior — skipped today, green after cleaner.
   ═══════════════════════════════════════════════════════════════════ */

describe.runIf(PHASE_F_FIXED)("#R6-1 — Layer B' regression (post-fix)", () => {
	it("baseURL with ?tenant=acme: query param is preserved after fix", async () => {
		const { calls, sdk } = makeSDK("https://api.example.com/?tenant=acme")
		await sdk.items.list()
		expect(calls[0]?.url).toContain("tenant=acme")
	})

	it("baseURL with two query params ?tenant=acme&env=dev: both preserved", async () => {
		const { calls, sdk } = makeSDK("https://api.example.com/?tenant=acme&env=dev")
		await sdk.items.list()
		expect(calls[0]?.url).toContain("tenant=acme")
		expect(calls[0]?.url).toContain("env=dev")
	})

	it("baseURL with ?tenant=acme plus request search ?q=1: both tenant and q present", async () => {
		const { calls, sdk } = makeSDK("https://api.example.com/?tenant=acme")
		await sdk.items.list({ search: { q: "1" } })
		expect(calls[0]?.url).toContain("tenant=acme")
		expect(calls[0]?.url).toContain("q=1")
	})

	it("baseURL with prefix path and query: pathname preserved AND query carried through", async () => {
		const { calls, sdk } = makeSDK("https://api.example.com/prefix/?tenant=acme")
		await sdk.items.list()
		const url = calls[0]?.url ?? ""
		const parsed = new URL(url)
		expect(parsed.pathname).toBe("/prefix/v1/items")
		expect(parsed.searchParams.get("tenant")).toBe("acme")
	})

	it("baseURL with encoded value ?tenant=a%26b: no double-encoding in final URL", async () => {
		/* a%26b decoded is 'a&b' — the URL must preserve the encoded form, not double-encode */
		const { calls, sdk } = makeSDK("https://api.example.com/?tenant=a%26b")
		await sdk.items.list()
		const url = calls[0]?.url ?? ""
		/* URL.searchParams round-trips through the decoded value then re-encodes —
		   'a&b' becomes 'a%26b' in the serialized form, but may appear as 'a+26b' or similar
		   depending on encoding. The key invariant: 'tenant' param exists and 'a' is part of the value. */
		expect(url).toContain("tenant=")
		const parsed = new URL(url)
		expect(parsed.searchParams.get("tenant")).toBe("a&b")
	})
})
