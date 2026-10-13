import type { HoneyMeta, HoneyMetaSpec } from "../../src/index.ts"
import { honey } from "../../src/index.ts"

type AppRouteMeta = {
	permissions?: string[]
	rateLimit?: "ai" | "login"
	tenant?: string
	worker?: "extract" | "saas"
}
type AppMeta = HoneyMeta<AppRouteMeta>

/* ---- totality is enforced at the call site ---- */

const complete = honey<{}>()
	.meta<AppMeta>()
	.metaSpec({
		meta: {
			permissions: "x-permissions",
			rateLimit: { key: "x-rate-limit", map: (v) => ({ category: v }) },
			tenant: "x-tenant",
			worker: false,
		},
	})
void complete

honey<{}>()
	.meta<AppMeta>()
	.metaSpec({
		// @ts-expect-error — `worker` has no policy entry: emit it or hide it with `false`
		meta: {
			permissions: "x-permissions",
			rateLimit: "x-rate-limit",
			tenant: "x-tenant",
		},
	})

/*
 * A policy key that is not a meta key is NOT rejected here: `.metaSpec()` takes a generic
 * `TSpec extends HoneyMetaSpec<TMeta>` (needed to keep Honey's variance in TMeta), and TypeScript
 * does not excess-property-check an object literal inferred as a generic. The typo still surfaces,
 * from the other side: the *real* key it was meant to name has no entry, so codegen reports
 * MISSING_ENTRY for it under `strict: "error"`.
 */
honey<{}>()
	.meta<AppMeta>()
	.metaSpec({
		meta: {
			permissions: "x-permissions",
			rateLimit: "x-rate-limit",
			tenant: "x-tenant",
			typoKey: "x-typo",
			worker: false,
		},
	})

/* ---- built-in meta keys stay optional ---- */

const builtinsOptional = honey<{}>()
	.meta<AppMeta>()
	.metaSpec({
		meta: { permissions: false, rateLimit: false, tenant: false, worker: false },
	})
void builtinsOptional

/* ---- `map` sees the field's own type ---- */

honey<{}>()
	.meta<AppMeta>()
	.metaSpec({
		meta: {
			permissions: {
				key: "x-permissions",
				map: (v) => {
					const arr: string[] = v
					return arr
				},
			},
			rateLimit: {
				key: "x-rate-limit",
				// @ts-expect-error — `rateLimit` is a string union, not a number
				map: (v: number) => v,
			},
			tenant: false,
			worker: false,
		},
	})

/* ---- a policy can live in a shared package, typed against the shared meta ---- */

const sharedPolicy = {
	meta: {
		permissions: "x-permissions",
		rateLimit: "x-rate-limit",
		tenant: "x-tenant",
		worker: false,
	},
	profiles: { public: { include: ["x-entity"] } },
	strict: "error",
} as const satisfies HoneyMetaSpec<AppMeta>

const fromShared = honey<{}>().meta<AppMeta>().metaSpec(sharedPolicy)
void fromShared

/* ---- an app that declares no meta type may still declare a policy ---- */

const untyped = honey<{}>().metaSpec({ meta: { anything: "x-anything" }, strict: "warn" })
void untyped
