import type { IncomingMessage } from "node:http"

/**
 * Fetch's `Headers` over Node's parsed headers. `get` and `has` read the maps Node already built;
 * a real `Headers` is built only when something iterates or writes, and answers from then on.
 */
export class NodeHeaders {
	readonly #incoming: IncomingMessage
	#native: Headers | null = null

	constructor(incoming: IncomingMessage) {
		this.#incoming = incoming
	}

	/**
	 * Every value, joined as Fetch joins them. Node's `headers` map keeps only the first
	 * `Authorization`, `Host`, …; `headersDistinct` keeps them all, so the answer does not change
	 * once something iterates.
	 */
	get(name: string): string | null {
		if (this.#native !== null) return this.#native.get(name)
		const all = this.#incoming.headersDistinct
		const key = name.toLowerCase()
		if (!Object.hasOwn(all, key)) return null
		const values = all[key] as string[]
		return values.length === 1 ? (values[0] as string) : values.join(", ")
	}

	has(name: string): boolean {
		if (this.#native !== null) return this.#native.has(name)
		return Object.hasOwn(this.#incoming.headers, name.toLowerCase())
	}

	append(name: string, value: string): void {
		this.#ensureNative().append(name, value)
	}

	delete(name: string): void {
		this.#ensureNative().delete(name)
	}

	set(name: string, value: string): void {
		this.#ensureNative().set(name, value)
	}

	getSetCookie(): string[] {
		return this.#ensureNative().getSetCookie()
	}

	forEach(callback: (value: string, key: string, parent: Headers) => void, thisArg?: unknown): void {
		this.#ensureNative().forEach(callback, thisArg)
	}

	keys(): HeadersIterator<string> {
		return this.#ensureNative().keys()
	}

	values(): HeadersIterator<string> {
		return this.#ensureNative().values()
	}

	entries(): HeadersIterator<[string, string]> {
		return this.#ensureNative().entries()
	}

	[Symbol.iterator](): HeadersIterator<[string, string]> {
		return this.#ensureNative()[Symbol.iterator]()
	}

	get [Symbol.toStringTag](): string {
		return "Headers"
	}

	/* from the raw pairs, so every repeated value survives */
	#ensureNative(): Headers {
		if (this.#native !== null) return this.#native
		const headers = new Headers()
		const raw = this.#incoming.rawHeaders
		for (let i = 0; i < raw.length; i += 2) headers.append(raw[i] as string, raw[i + 1] as string)
		this.#native = headers
		return headers
	}
}
