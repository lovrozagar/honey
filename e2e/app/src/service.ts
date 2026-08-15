import type { AppCtx } from "./context"

type HelloGetCtx = AppCtx & { input: { search: { q: string } } }

export class Service {
	static list(ctx: HelloGetCtx) {
		return ctx.db.query(`WHERE q = ${ctx.input.search.q}`)
	}
}
