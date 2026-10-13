import { generateManifest, generateOpenApi } from "../codegen.ts"
import { toYaml } from "../yaml.ts"
import { scalar } from "./scalar.ts"
import { artifactResponse, toServedArtifact } from "./serve.ts"
import { swagger } from "./swagger.ts"
import { registerOpenApiRuntime } from "./spec-factory.ts"

export function enableOpenApi(): void {
	registerOpenApiRuntime({
		artifactResponse,
		docsUi: (kind, specUrl) => (kind === "swagger" ? swagger({ url: specUrl }) : scalar({ url: specUrl })),
		/* served artifacts follow the document's visibility policy and never fail on one schema */
		generateManifest: (app, options) =>
			Promise.resolve(generateManifest(app as never, { visibility: "published", ...options })),
		generateOpenApi: (app, options) => generateOpenApi(app as never, { onSchemaError: "warn", ...options }),
		toServedArtifact,
		toYaml,
	})
}

enableOpenApi()

export { spec } from "./spec.ts"
