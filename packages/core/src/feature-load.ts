import { getI18nRuntime } from "./i18n-slot.ts"
import { getOpenApiRuntime } from "./openapi/spec-factory.ts"
import { getServeRuntime } from "./serve-slot.ts"

function isReady(name: "i18n" | "openapi" | "serve"): boolean {
	try {
		if (name === "i18n") getI18nRuntime()
		else if (name === "openapi") getOpenApiRuntime()
		else getServeRuntime()
		return true
	} catch {
		return false
	}
}

/** Opaque so bun/esbuild do not follow unused feature entries into a fetch-only bundle. */
export async function loadHoneyFeature(name: "i18n" | "openapi" | "serve"): Promise<void> {
	if (isReady(name)) return
	const mod = (await import(["@lovrozagar/honey", name].join("/"))) as Record<string, unknown>
	const enable = { i18n: "enableI18n", openapi: "enableOpenApi", serve: "enableServe" }[name]
	const fn = mod[enable]
	if (typeof fn === "function") fn()
}
