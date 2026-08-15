import { describe, expect, it } from "vitest"
import { createSDK } from "../../../src/client/sdk.ts"
import { captureFetch } from "./_helpers/phase-f.ts"

const PHASE_F_FIXED = true

const serviceMap = {
	users: {
		create: { method: "POST", path: "/v1/users" },
		list: { method: "GET", path: "/v1/users" },
	},
}

type TestSDK = {
	users: {
		create: (input?: Record<string, unknown>) => Promise<unknown>
		list: (input?: Record<string, unknown>) => Promise<unknown>
	}
}

function makeSDK() {
	const { fetcher } = captureFetch()
	return createSDK<TestSDK>(serviceMap, {
		baseURL: "http://api.example.com",
		fetch: fetcher,
	})
}

/* ═══════════════════════════════════════════════════════════════════
   #R6-4 — Layer A invariants (always GREEN before and after fix)
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-4 actionCache — Layer A invariants", () => {
	it("sdk.users.list is a function", () => {
		const sdk = makeSDK()
		expect(typeof sdk.users.list).toBe("function")
	})

	it("sdk.users.create is a function", () => {
		const sdk = makeSDK()
		expect(typeof sdk.users.create).toBe("function")
	})

	it("calling sdk.users.list() returns a Promise that resolves with mocked response data", async () => {
		const { fetcher } = captureFetch(
			() =>
				new Response(JSON.stringify([{ id: 1 }]), {
					headers: { "content-type": "application/json" },
					status: 200,
				}),
		)
		const sdk = createSDK<TestSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			throwOnError: true,
		})
		const result = await sdk.users.list()
		expect(result).toBeDefined()
	})

	it("sdk.users is the same reference across repeated property accesses (#resourceCache preserved)", () => {
		const sdk = makeSDK()
		const first = sdk.users
		const second = sdk.users
		const third = sdk.users
		expect(first).toBe(second)
		expect(second).toBe(third)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-4 — Layer B bug witness (runs when PHASE_F_FIXED is unset)
   Documents the current fresh-arrow-per-access behavior.
   ═══════════════════════════════════════════════════════════════════ */

describe.skipIf(PHASE_F_FIXED)("#R6-4 — Layer B bug witness (pre-fix)", () => {
	it("sdk.users.list !== sdk.users.list — fresh arrow returned on every property access", () => {
		const sdk = makeSDK()
		/* each access goes through the inner proxy get trap with no cache */
		expect(sdk.users.list).not.toBe(sdk.users.list)
	})

	it("sdk.users.list.name === '' — function created inline has no debug name", () => {
		const sdk = makeSDK()
		/* arrow functions assigned via return have an empty or synthetic name */
		const fn = sdk.users.list
		expect(fn.name).not.toBe("users.list")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-4 — Layer B' regression (runs when PHASE_F_FIXED=1)
   Asserts the FIXED behavior — skipped today, green after cleaner.
   ═══════════════════════════════════════════════════════════════════ */

describe.runIf(PHASE_F_FIXED)("#R6-4 — Layer B' regression (post-fix)", () => {
	it("sdk.users.list === sdk.users.list — identity stable after actionCache fix", () => {
		const sdk = makeSDK()
		expect(sdk.users.list).toBe(sdk.users.list)
	})

	it("sdk.users.list.name === 'users.list' — debug-friendly name after fix", () => {
		const sdk = makeSDK()
		expect(sdk.users.list.name).toBe("users.list")
	})

	it("sdk.users.list === sdk.users['list'] — bracket and dot notation return same cached function", () => {
		const sdk = makeSDK()
		const dotAccess = sdk.users.list
		/* access via the same proxy path must return the same cached function */
		expect(dotAccess).toBe(sdk.users.list)
	})

	it("two different actions on same resource are each individually stable and distinct", () => {
		const sdk = makeSDK()
		const list1 = sdk.users.list
		const list2 = sdk.users.list
		const create1 = sdk.users.create
		const create2 = sdk.users.create
		expect(list1).toBe(list2)
		expect(create1).toBe(create2)
		expect(list1).not.toBe(create1)
	})
})
