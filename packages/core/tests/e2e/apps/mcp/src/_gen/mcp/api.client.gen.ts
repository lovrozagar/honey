import { SDKClient, schemeAuth } from "./api.runtime.gen.js"
import { serviceMap } from "./api.map.gen.js"
import type { ApiConfig, ApiOperations, ApiSafe } from "./api.types.gen.js"

export class Api extends SDKClient {
	constructor(config: ApiConfig) {
		super(serviceMap, schemeAuth({ ...config, baseURL: config.baseURL ?? "/api" }, "Authorization", "ApiKey "))
	}
}

/* declaration merge: the Proxy-backed class carries the typed operations, and their safe twins */
export interface Api extends ApiOperations {
	readonly safe: ApiSafe
}
