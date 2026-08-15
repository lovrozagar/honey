import type { HelloGetCtx } from "./honey.gen"

export class Service {
	static list(ctx: HelloGetCtx) {
		return ctx.db.query(`WHERE q = ${ctx.input.search.q}`)
	}
}
