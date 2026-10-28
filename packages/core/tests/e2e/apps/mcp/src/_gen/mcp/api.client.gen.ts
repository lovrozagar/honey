import { SDKClient, schemeAuth } from "./api.runtime.gen"
import { serviceMap } from "./api.map.gen"
import type { ApiConfig, ApiOperations } from "./api.types.gen"

export class Api<TThrow extends boolean = false> extends SDKClient {
	constructor(config: ApiConfig<TThrow>) {
		super(serviceMap, schemeAuth({ ...config, baseURL: config.baseURL ?? "/api" }, "Authorization", "ApiKey "))
	}
}

/* declaration merge: the Proxy-backed class carries the typed operations */
export interface Api<TThrow extends boolean = false> extends ApiOperations<TThrow> {}
