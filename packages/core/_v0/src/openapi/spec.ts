import type { TypedResponse } from "../response.ts"
import type { DefaultMeta } from "../types.ts"
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

type SpecCtx = { res: { raw(response: Response): TypedResponse } }

type Cached = { body: Promise<string>; epoch: number }

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" }

function appEpoch(app: object): number {
	return (app as { _epoch?: number })._epoch ?? 0
}

/**
 * Serve an OpenAPI document for the app the handler is mounted on.
 *
 * Walks the live route graph. Schemas are converted with the full codegen converter when
 * `@lovrozagar/honey/openapi` is loaded, and otherwise with what the schema instances carry
 * (Zod 4, ArkType), so a worker bundle still documents bodies and parameters. The serialized
 * document is cached per app and rebuilt when routes change; a failed build is cached for the
 * same route graph too, so a broken schema costs one build, not one per request.
 */
export function spec<TMeta = Record<string, unknown> | null>(
	options: SpecOptions<TMeta>,
): (ctx: SpecCtx, app?: unknown) => Promise<TypedResponse> {
	const cache = new WeakMap<object, Cached>()
	const info = { description: options.description, title: options.title, version: options.version }

	const build = async (app: object): Promise<string> => {
		const generateOptions = {
			filterRoutes: options.filterRoutes as ((route: OpenApiRouteInfo) => boolean) | undefined,
			info,
			/* a served document is not an authoring moment — the check belongs to `honey generate` */
			invalidate: "off" as const,
			profile: options.profile,
			securitySchemes: options.securitySchemes,
		}
		const runtime = tryGetOpenApiRuntime()
		const document = runtime
			? await runtime.generateOpenApi(app, { ...generateOptions, onSchemaError: "warn" })
			: generateOpenApiFromTree(app, generateOptions)
		return JSON.stringify(document)
	}

	const handler = async (ctx: SpecCtx, bound?: unknown): Promise<TypedResponse> => {
		const app = (bound ?? Object.getOwnPropertyDescriptor(handler, Symbol.for("honey.app"))?.value) as
			| object
			| undefined
		if (app === undefined) {
			throw new Error("spec(): the handler is not mounted on an app — register it with app.get(path, spec(...))")
		}
		const epoch = appEpoch(app)
		let entry = cache.get(app)
		if (entry === undefined || entry.epoch !== epoch) {
			entry = { body: build(app), epoch }
			cache.set(app, entry)
		}
		return ctx.res.raw(new Response(await entry.body, { headers: JSON_HEADERS }))
	}
	Object.defineProperty(handler, Symbol.for("honey.internal"), { value: true })
	return handler
}
