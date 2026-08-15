import { generateManifest, generateOpenApi } from "../codegen.ts"
import { toYaml } from "../yaml.ts"
import { scalar } from "./scalar.ts"
import { swagger } from "./swagger.ts"
import { registerOpenApiRuntime } from "./spec-factory.ts"

export function enableOpenApi(): void {
	registerOpenApiRuntime({
		docsUi: (kind, specUrl) =>
			kind === "swagger" ? swagger({ url: specUrl }) : scalar({ url: specUrl }),
		generateManifest: (app) => Promise.resolve(generateManifest(app as never)),
		generateOpenApi: (app, options) => generateOpenApi(app as never, options),
		toYaml,
	})
}

enableOpenApi()

export { spec } from "./spec.ts"
