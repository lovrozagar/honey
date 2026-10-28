/**
 * A Worker app with a Durable Object (bit 21 h): `/count` counts in one object's storage, so it answers only when the
 * built Worker exports the object class its COUNTER binding names, beside honey's default fetch.
 */
import { honey } from "../../../src/routing/app.ts"

type Storage = { get(key: string): Promise<number | undefined>; put(key: string, value: number): Promise<void> }
type Namespace = { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string): Promise<Response> } }

/** One counter: each request adds one and answers the count. */
export class Counter {
	readonly #storage: Storage

	constructor(state: { readonly storage: Storage }) {
		this.#storage = state.storage
	}

	async fetch(): Promise<Response> {
		const count = ((await this.#storage.get("count")) ?? 0) + 1
		await this.#storage.put("count", count)
		return new Response(String(count))
	}
}

export const app = honey<{ readonly COUNTER: Namespace }>()
	.get("/count")
	.handler(async (ctx) =>
		ctx.res.raw(await ctx.env.COUNTER.get(ctx.env.COUNTER.idFromName("one")).fetch("https://counter/")),
	)
