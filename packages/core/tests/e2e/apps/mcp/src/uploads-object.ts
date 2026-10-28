/**
 * The e2e mcp app's Durable Object UploadStore (bit 21 h, the reviewer's ruling), for its Cloudflare Worker alone:
 * test code, never shipped. One object an upload id, so the claim is the object's own: an object runs one event at a
 * time and its storage calls hold its input gate, so of two claims racing from any isolates one alone finds the id
 * unclaimed. The bytes live in the object's storage too, which holds at most 2 MB a value (a SQLite-backed object's
 * row): the app caps an upload at 1 MiB for that. A production store at the 50 MiB default keeps the claim and take
 * in D1 or a Durable Object and the bytes in R2 (docs/mcp.md, "The store must claim atomically"). Each object deletes
 * what it holds when the upload expires (an alarm), so nothing outlives its token.
 */
import type { UploadStore } from "@lovrozagar/honey/mcp/uploads"

/** As much of a Durable Object's storage as the object uses. */
type Storage = {
	get<T>(key: string): Promise<T | undefined>
	put(entries: Record<string, unknown>): Promise<void>
	delete(key: string): Promise<boolean>
	deleteAll(): Promise<void>
	setAlarm(at: number): Promise<void>
}

/** As much of a Durable Object namespace binding as the store uses. */
export type UploadsNamespace = {
	idFromName(name: string): unknown
	get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> }
}

/** One upload's object: `/claim` (201 for the first claim alone, else 409), `/put` (its bytes), `/take` (once). */
export class McpUploads {
	readonly #storage: Storage

	constructor(state: { readonly storage: Storage }) {
		this.#storage = state.storage
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		const expires = Number(url.searchParams.get("expires"))
		switch (url.pathname) {
			case "/claim":
				if ((await this.#storage.get<number>("claimed")) !== undefined) return new Response(null, { status: 409 })
				await this.#storage.put({ claimed: expires })
				await this.#storage.setAlarm(expires)
				return new Response(null, { status: 201 })
			case "/put":
				await this.#storage.put({ bytes: new Uint8Array(await request.arrayBuffer()) })
				return new Response(null, { status: 204 })
			case "/take": {
				const bytes = await this.#storage.get<Uint8Array>("bytes")
				const claimed = (await this.#storage.get<number>("claimed")) ?? 0
				if (bytes === undefined || Date.now() > claimed) return new Response(null, { status: 404 })
				await this.#storage.delete("bytes")
				return new Response(bytes as Uint8Array<ArrayBuffer>)
			}
			default:
				return new Response(null, { status: 404 })
		}
	}

	/** The upload expired: nothing of it is kept. */
	async alarm(): Promise<void> {
		await this.#storage.deleteAll()
	}
}

/** An UploadStore over `namespace()`'s objects, one an upload id. */
export function durableUploadStore(namespace: () => UploadsNamespace): UploadStore {
	const object = (id: string) => namespace().get(namespace().idFromName(id))
	return {
		claim: async (id, expires) =>
			(await object(id).fetch(`https://upload/claim?expires=${expires}`, { method: "POST" })).status === 201,
		put: async (id, bytes) => {
			await object(id).fetch("https://upload/put", { body: bytes as Uint8Array<ArrayBuffer>, method: "PUT" })
		},
		take: async (id) => {
			const taken = await object(id).fetch("https://upload/take", { method: "POST" })
			return taken.status === 200 ? new Uint8Array(await taken.arrayBuffer()) : undefined
		},
	}
}
