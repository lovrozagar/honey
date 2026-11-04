import { SDKClient, schemeAuth } from "./kitchen.runtime.gen.js"
import { serviceMap } from "./kitchen.map.gen.js"
import type { KitchenConfig, KitchenOperations, KitchenSafe } from "./kitchen.types.gen.js"

export class Kitchen extends SDKClient {
	constructor(config: KitchenConfig) {
		super(serviceMap, schemeAuth(config, "Authorization", "Bearer "))
	}
}

/* declaration merge: the Proxy-backed class carries the typed operations, and their safe twins */
export interface Kitchen extends KitchenOperations {
	readonly safe: KitchenSafe
}
