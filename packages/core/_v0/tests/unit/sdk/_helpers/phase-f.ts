/* shared test helpers for Phase F characterization tests */

/**
 * Drains the microtask queue enough for a `deferredFetch` call to register.
 * `createSDK` actions are async and call `buildHeaders` (also async) before
 * reaching `fetch`, so two microtask levels must flush. Always `await tick()`
 * after starting an SDK call and before calling `resolveCall`.
 */
export async function tick(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

type DeferredCall = {
	init: RequestInit | undefined
	reject: (e: unknown) => void
	resolve: (r: Response) => void
	url: string
}

/**
 * Returns a manually-resolvable fetch stub. Each invocation pushes a new entry
 * into `calls` with `resolve` and `reject` handles. The test script drives
 * resolution order deterministically — no timers, no flake.
 */
export function deferredFetch(): {
	calls: DeferredCall[]
	fetcher: typeof fetch
} {
	const calls: DeferredCall[] = []

	const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		return new Promise<Response>((resolve, reject) => {
			calls.push({ init, reject, resolve, url: String(input) })
		})
	}

	return { calls, fetcher: fetcher as typeof fetch }
}

type CaptureCall = {
	init: RequestInit | undefined
	url: string
}

/**
 * Returns a URL-capturing fetch that auto-resolves each call with the supplied
 * response factory (default: 200 application/json `{}`). Use this for URL and
 * header assertions where the request body is irrelevant.
 */
export function captureFetch(response?: () => Response): {
	calls: CaptureCall[]
	fetcher: typeof fetch
} {
	const calls: CaptureCall[] = []

	const defaultResponse = () =>
		new Response("{}", {
			headers: { "content-type": "application/json" },
			status: 200,
		})

	const factory = response ?? defaultResponse

	const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		calls.push({ init, url: String(input) })
		return Promise.resolve(factory())
	}

	return { calls, fetcher: fetcher as typeof fetch }
}
