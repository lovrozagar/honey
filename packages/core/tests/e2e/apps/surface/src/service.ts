import type { RouteCtx } from "./_gen/types.gen.d.ts"

type SearchCtx = RouteCtx<"/in/search", "get">

/**
 * A service typed with the generated per-route ctx, called with the handler's own ctx (bit 22 a): the shape a
 * consumer writes when its services live outside the app module, where `InferRouteCtx<typeof app, …>` would be a
 * circular import. The generated ctx must therefore accept what the handler has.
 */
export const SearchService = {
	run(ctx: SearchCtx): { auth: SearchCtx["meta"]["auth"]; page: number } {
		return { auth: ctx.meta.auth, page: ctx.input.search.page }
	},
}
