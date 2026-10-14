/**
 * `HoneyOutHeaders`: a `Headers` view over the plain map a buffered response was built with.
 * `get`/`has`/`getSetCookie`, plain iteration, `set` and `delete` use the map; a real `Headers` is
 * built only when something appends or walks it through the native API. The map keys are lower-case, as Fetch keeps them.
 */

export type HeaderMap = Record<string, string | string[]>

/** Copy native `Headers` into a map, keeping each `Set-Cookie` as its own entry. */
export function headersToRecord(headers: Headers): HeaderMap {
	const out: HeaderMap = {}
	headers.forEach((value, key) => {
		if (key !== "set-cookie") out[key] = value
	})
	const cookies = headers.getSetCookie()
	if (cookies.length > 0) out["set-cookie"] = cookies
	return out
}

function* iterateMap(map: HeaderMap): IterableIterator<[string, string]> {
	for (const key in map) {
		const value = map[key]
		if (Array.isArray(value)) for (const item of value) yield [key, item]
		else if (value !== undefined) yield [key, value]
	}
}

/* what Fetch accepts: a token name, and a value without CR, LF or NUL once its edges are trimmed */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const FORBIDDEN_IN_VALUE = /[\r\n\0]/
const EDGE_WHITESPACE = /^[\t\n\r ]+|[\t\n\r ]+$/g

function checkedName(name: string): string {
	if (!TOKEN.test(name)) throw new TypeError(`Headers: invalid header name "${name}"`)
	return name.toLowerCase()
}

export class HoneyOutHeaders {
	#map: HeaderMap
	#native: Headers | null = null
	/* the map may be shared (a frozen base the response was built from): the first write copies it */
	#owned = false

	constructor(map: HeaderMap) {
		this.#map = map
	}

	append(name: string, value: string): void {
		this.#ensureNative().append(name, value)
	}

	/** Removes `name`; on the plain map until something used the native API. */
	delete(name: string): void {
		if (this.#native) return this.#native.delete(name)
		const key = checkedName(name)
		if (Object.hasOwn(this.#map, key)) delete this.#writable()[key]
	}

	get(name: string): string | null {
		if (this.#native) return this.#native.get(name)
		const key = name.toLowerCase()
		/* own keys only: `get("constructor")` must not return Object */
		const raw = Object.hasOwn(this.#map, key) ? this.#map[key] : undefined
		if (raw === undefined) return null
		return Array.isArray(raw) ? raw.join(", ") : raw
	}

	getSetCookie(): string[] {
		if (this.#native) return this.#native.getSetCookie()
		const raw = Object.hasOwn(this.#map, "set-cookie") ? this.#map["set-cookie"] : undefined
		if (raw === undefined) return []
		return Array.isArray(raw) ? raw : [raw]
	}

	has(name: string): boolean {
		return this.get(name) !== null
	}

	/**
	 * Sets `name` on the plain map, validated and normalized as Fetch does, until something used the
	 * native API: a middleware's header write never builds native Headers.
	 */
	set(name: string, value: string): void {
		if (this.#native) return this.#native.set(name, value)
		const key = checkedName(name)
		const normalized = value.replace(EDGE_WHITESPACE, "")
		if (FORBIDDEN_IN_VALUE.test(normalized)) throw new TypeError(`Headers: invalid value for "${name}"`)
		this.#writable()[key] = normalized
	}

	forEach(callback: (value: string, key: string, parent: Headers) => void, thisArg?: unknown): void {
		this.#ensureNative().forEach(callback, thisArg)
	}

	keys(): IterableIterator<string> {
		return this.#ensureNative().keys()
	}

	values(): IterableIterator<string> {
		return this.#ensureNative().values()
	}

	entries(): IterableIterator<[string, string]> {
		return this.#ensureNative().entries()
	}

	[Symbol.iterator](): IterableIterator<[string, string]> {
		if (this.#native) return this.#native[Symbol.iterator]()
		return iterateMap(this.#map)
	}

	get [Symbol.toStringTag](): string {
		return "Headers"
	}

	/** The headers as a plain map: the original map until something wrote through the native API. */
	toRecord(): HeaderMap {
		return this.#native ? headersToRecord(this.#native) : this.#map
	}

	#writable(): HeaderMap {
		if (!this.#owned) {
			this.#map = { ...this.#map }
			this.#owned = true
		}
		return this.#map
	}

	#ensureNative(): Headers {
		if (this.#native) return this.#native
		const headers = new Headers()
		for (const [name, value] of iterateMap(this.#map)) headers.append(name, value)
		this.#native = headers
		return headers
	}
}
