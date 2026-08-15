import type { Routes } from "./honey.gen"

type OrgsGetCtx = Routes["/orgs"]["get"]["ctx"]
type OrgsOrgIdGetCtx = Routes["/orgs/:orgId"]["get"]["ctx"]
type OrgsPostCtx = Routes["/orgs"]["post"]["ctx"]

export class OrgService {
	static list(ctx: OrgsGetCtx) {
		return ctx.db.query("SELECT * FROM orgs", []) as string[]
	}

	static getById(ctx: OrgsOrgIdGetCtx) {
		const row = ctx.db.query("SELECT * FROM orgs WHERE id = ?", [ctx.params.orgId])[0]
		if (!row) throw ctx.errors.not_found()
		return row
	}

	static create(ctx: OrgsPostCtx) {
		const existing = ctx.db.query("SELECT 1 FROM orgs WHERE slug = ?", [ctx.input.json.slug])
		if (existing.length > 0) {
			throw ctx.errors.org_slug_taken({ vars: { slug: ctx.input.json.slug } })
		}
		ctx.db.query("INSERT INTO orgs (name, slug) VALUES (?, ?)", [
			ctx.input.json.name,
			ctx.input.json.slug,
		])
		return { name: ctx.input.json.name, slug: ctx.input.json.slug }
	}
}
