import type { Routes } from "./honey.gen"

/**
 * Services that import ctx types from the generated file.
 * Tests that gen types work as expected for service layer patterns.
 */

type SearchCtx = Routes["/in/search"]["get"]["ctx"]
type ParamsCtx = Routes["/in/params/:orgId/members/:memberId"]["get"]["ctx"]
type JsonCtx = Routes["/in/json"]["post"]["ctx"]
type ResourceListCtx = Routes["/methods/resource"]["get"]["ctx"]
type ResourceByIdCtx = Routes["/methods/resource/:id"]["put"]["ctx"]

export class ResourceService {
	static list(ctx: ResourceListCtx) {
		return ctx.res.json("ok", { items: [] as string[] })
	}

	static update(ctx: ResourceByIdCtx) {
		const id = ctx.params.id
		const name = ctx.input.json.name
		return ctx.res.json("ok", { id, name })
	}
}

export function searchItems(ctx: SearchCtx) {
	const { limit, page } = ctx.input.search
	return ctx.res.json("ok", { results: [] as string[] })
}

export function getMember(ctx: ParamsCtx) {
	return ctx.res.json("ok", {
		memberId: ctx.params.memberId,
		orgId: ctx.params.orgId,
	})
}

export function createItem(ctx: JsonCtx) {
	const { email, name } = ctx.input.json
	return ctx.res.json("created", { id: `${name}-${email}` })
}
