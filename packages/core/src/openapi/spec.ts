import type { DefaultMeta } from "../types.ts"
import type { TypedResponse } from "../response.ts"
import { generateOpenApiFromTree, type OpenApiRouteInfo } from "./document.ts"
import { tryGetOpenApiRuntime } from "./spec-factory.ts"

type SpecOptions<TMeta = Record<string, unknown> | null> = {
	description?: string
	filterRoutes?: (route: OpenApiRouteInfo<DefaultMeta & TMeta>) => boolean
	/** Named metaSpec profile selecting which emitted keys this document carries */
	profile?: string
	securitySchemes?: Record<string, unknown>
	title: string
	version: string
}

/** Walks the live or intern tree. Intern trees omit `iv`/`os`; serve generate-time OpenAPI JSON as assets instead of this walker on a gateway isolate. */
export function spec<TMeta = Record<string, unknown> | null>(
	options: SpecOptions<TMeta>,
): (ctx: { res: { json(sk: "ok", data: unknown): TypedResponse } }) => TypedResponse | Promise<TypedResponse> {
	let cached: string | null = null

	const handler = async (ctx: { res: { json(sk: "ok", data: unknown): TypedResponse } }) => {
		if (cached === null) {
			const desc = Object.getOwnPropertyDescriptor(handler, Symbol.for("honey.app"))
			const app = desc?.value
			const generateOptions = {
				filterRoutes: options.filterRoutes,
				info: options,
				/* a served document is not an authoring moment — the check belongs to `honey generate` */
				invalidate: "off" as const,
				profile: options.profile,
				securitySchemes: options.securitySchemes,
			}
			const runtime = tryGetOpenApiRuntime()
			const openApiSpec = app
				? runtime
					? await runtime.generateOpenApi(app, {
							...generateOptions,
							filterRoutes: options.filterRoutes as
								| ((route: { meta: unknown; method: string; path: string }) => boolean)
								| undefined,
						})
					: generateOpenApiFromTree(app, generateOptions)
				: {}
			cached = JSON.stringify(openApiSpec)
		}
		return ctx.res.json("ok", JSON.parse(cached))
	}
	Object.defineProperty(handler, Symbol.for("honey.internal"), { value: true })
	return handler
}
