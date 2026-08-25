import { afterEach, describe, expect, it } from "vitest"
import { bindDefaultFetch, invalidBaseURLError, parseClientBaseURL } from "../../../src/client/defaults.ts"

const ORIGIN = "https://app.example.com"

function restoreLocation(desc: PropertyDescriptor | undefined): void {
	if (desc) Object.defineProperty(globalThis, "location", desc)
	else Reflect.deleteProperty(globalThis, "location")
}

function withLocationOrigin<T>(origin: unknown, fn: () => T): T {
	const desc = Object.getOwnPropertyDescriptor(globalThis, "location")
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		enumerable: true,
		value: { origin },
		writable: true,
	})
	try {
		return fn()
	} finally {
		restoreLocation(desc)
	}
}

function withNoLocation<T>(fn: () => T): T {
	const desc = Object.getOwnPropertyDescriptor(globalThis, "location")
	Reflect.deleteProperty(globalThis, "location")
	try {
		return fn()
	} finally {
		restoreLocation(desc)
	}
}

describe("bindDefaultFetch", () => {
	it("returns a provided fetch unchanged", () => {
		const custom = (async () => new Response()) as typeof fetch
		expect(bindDefaultFetch(custom)).toBe(custom)
	})

	it("binds the environment fetch so a method-style fetch is not illegally invoked", async () => {
		const previous = globalThis.fetch
		const seen: unknown[] = []
		function methodFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
			if (this !== globalThis) {
				throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
			}
			seen.push(input)
			return Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" }, status: 200 }))
		}
		globalThis.fetch = methodFetch as typeof fetch
		try {
			const fetchFn = bindDefaultFetch()
			const res = await fetchFn("https://api.example.com/health")
			expect(res.status).toBe(200)
			expect(seen).toEqual(["https://api.example.com/health"])
		} finally {
			globalThis.fetch = previous
		}
	})

	it("returns a missing environment fetch as-is", () => {
		const previous = globalThis.fetch
		;(globalThis as { fetch?: typeof fetch }).fetch = undefined
		try {
			expect(bindDefaultFetch()).toBeUndefined()
		} finally {
			globalThis.fetch = previous
		}
	})

	it("returns a non-function environment fetch as-is", () => {
		const previous = globalThis.fetch
		;(globalThis as { fetch: unknown }).fetch = 1
		try {
			expect(bindDefaultFetch()).toBe(1)
		} finally {
			globalThis.fetch = previous
		}
	})
})

describe("parseClientBaseURL", () => {
	afterEach(() => {
		const desc = Object.getOwnPropertyDescriptor(globalThis, "location")
		if (desc?.configurable) Reflect.deleteProperty(globalThis, "location")
	})

	it("keeps absolute http(s) and ws(s) URLs unchanged", () => {
		expect(parseClientBaseURL("https://api.example.com/v1").href).toBe("https://api.example.com/v1")
		expect(parseClientBaseURL("http://127.0.0.1:3000").href).toBe("http://127.0.0.1:3000/")
		expect(parseClientBaseURL("ws://localhost:3000/echo").href).toBe("ws://localhost:3000/echo")
		expect(parseClientBaseURL("wss://api.example.com/rt").href).toBe("wss://api.example.com/rt")
		expect(parseClientBaseURL("HTTP://API.EXAMPLE.COM").href).toBe("http://api.example.com/")
	})

	it("does not rewrite an absolute URL when location.origin is present", () => {
		withLocationOrigin(ORIGIN, () => {
			expect(parseClientBaseURL("https://api.example.com/v1").href).toBe("https://api.example.com/v1")
		})
	})

	it("resolves a path-only baseURL against location.origin", () => {
		withLocationOrigin(ORIGIN, () => {
			expect(parseClientBaseURL("/api").href).toBe("https://app.example.com/api")
			expect(parseClientBaseURL("/api/").href).toBe("https://app.example.com/api/")
		})
	})

	it("throws a clear error when a path-only baseURL has no origin", () => {
		withNoLocation(() => {
			expect(() => parseClientBaseURL("/api")).toThrow(invalidBaseURLError("/api").message)
		})
	})

	it("throws a clear error when location.origin is the opaque string null", () => {
		withLocationOrigin("null", () => {
			expect(() => parseClientBaseURL("/api")).toThrow(/expected an absolute http\(s\): or ws\(s\): URL/)
		})
	})

	it("throws a clear error when location.origin is empty", () => {
		withLocationOrigin("", () => {
			expect(() => parseClientBaseURL("/api")).toThrow(/expected an absolute http\(s\): or ws\(s\): URL/)
		})
	})

	it("throws a clear error when location.origin is not an http(s)/ws(s) origin", () => {
		withLocationOrigin("file://", () => {
			expect(() => parseClientBaseURL("/api")).toThrow(/expected an absolute http\(s\): or ws\(s\): URL/)
		})
	})

	it("throws a clear error when location.origin is not a string", () => {
		withLocationOrigin(undefined, () => {
			expect(() => parseClientBaseURL("/api")).toThrow(/expected an absolute http\(s\): or ws\(s\): URL/)
		})
	})

	it("treats a throwing location getter as no origin", () => {
		const desc = Object.getOwnPropertyDescriptor(globalThis, "location")
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			get() {
				throw new Error("blocked")
			},
		})
		try {
			expect(() => parseClientBaseURL("/api")).toThrow(/expected an absolute http\(s\): or ws\(s\): URL/)
		} finally {
			restoreLocation(desc)
		}
	})

	it("throws a clear error when a relative baseURL cannot be parsed against the origin", () => {
		withLocationOrigin(ORIGIN, () => {
			expect(() => parseClientBaseURL("///")).toThrow(invalidBaseURLError("///").message)
		})
	})
})
