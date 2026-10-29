/**
 * A Worker app whose entry exports plain values beside its app and its Durable Object class (bit 21 h fold-in): an
 * object, a string and a function, as an ordinary app module does (`export const config = {…}`). `/count` answers
 * through the object, `/config` reads the plain values, so the Worker serves only if workerd loaded the module.
 */
import { honey } from "../../../src/routing/app.ts"

type Storage = { get(key: string): Promise<number | undefined>; put(key: string, value: number): Promise<void> }
type Namespace = { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string): Promise<Response> } }

/** The app's settings, as an app module exports them. */
export const config = { region: "eu", retries: 2 }

/** A label, a string export. */
export const LABEL = "honey-build-values"

/** A helper the app module exports for its tests. */
export function describe(): string {
	return `${LABEL} in ${config.region}`
}

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
	.get("/config")
	.handler((ctx) => ctx.res.text("ok", describe()))
