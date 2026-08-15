import { generateOpenApi } from "../codegen.ts"
import type { OpenApiRouteInfo } from "../codegen.ts"
import type { DefaultMeta } from "../types.ts"
import type { TypedResponse } from "../response.ts"

type SpecOptions<TMeta = Record<string, unknown> | null> = {
  description?: string
  filterRoutes?: (route: OpenApiRouteInfo<DefaultMeta & TMeta>) => boolean
  securitySchemes?: Record<string, unknown>
  title: string
  version: string
}

export function spec<TMeta = Record<string, unknown> | null>(
  options: SpecOptions<TMeta>,
): (ctx: { res: { json(sk: "ok", data: unknown): TypedResponse } }) => TypedResponse | Promise<TypedResponse> {
  let cached: string | null = null

  const handler = async (ctx: { res: { json(sk: "ok", data: unknown): TypedResponse } }) => {
    if (cached === null) {
      const desc = Object.getOwnPropertyDescriptor(handler, Symbol.for("honey.app"))
      const openApiSpec = desc
        ? await generateOpenApi(desc.value, { filterRoutes: options.filterRoutes, info: options, securitySchemes: options.securitySchemes })
        : {}
      cached = JSON.stringify(openApiSpec)
    }
    return ctx.res.json("ok", JSON.parse(cached))
  }
  Object.defineProperty(handler, Symbol.for("honey.internal"), { value: true })
  return handler
}
