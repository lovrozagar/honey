/**
 * `HoneyOutHeaders`: a `Headers` view over the plain map a buffered response was built with.
 * `get`/`has`/`getSetCookie` and plain iteration read the map; a real `Headers` is built only when
 * something writes or walks it through the native API. The map keys are lower-case, as Fetch keeps them.
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

export class HoneyOutHeaders {
	#map: HeaderMap
	#native: Headers | null = null

	constructor(map: HeaderMap) {
		this.#map = map
	}

	append(name: string, value: string): void {
		this.#ensureNative().append(name, value)
	}

	delete(name: string): void {
		this.#ensureNative().delete(name)
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

	set(name: string, value: string): void {
		this.#ensureNative().set(name, value)
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

	#ensureNative(): Headers {
		if (this.#native) return this.#native
		const headers = new Headers()
		for (const [name, value] of iterateMap(this.#map)) headers.append(name, value)
		this.#native = headers
		return headers
	}
}
