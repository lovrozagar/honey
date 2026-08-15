import type { WSAdapter } from "honey"
import { createApp as createCompose } from "@honey/e2e-compose"
import { createApp as createDefaults } from "@honey/e2e-defaults"
import { createApp as createGateway } from "@honey/e2e-gateway"
import { createApp as createKitchen } from "@honey/e2e-kitchen"
import { createApp as createSurface } from "@honey/e2e-surface"

export const e2eApps = {
	compose: createCompose,
	defaults: createDefaults,
	gateway: createGateway,
	kitchen: createKitchen,
	surface: createSurface,
} as const

export type E2eAppName = keyof typeof e2eApps

export function isE2eAppName(name: string): name is E2eAppName {
	return name in e2eApps
}

export function loadE2eApp(name: string | undefined, wsAdapter?: WSAdapter) {
	const key = name ?? "kitchen"
	if (!isE2eAppName(key)) {
		throw new Error(`unknown e2e app "${key}". known: ${Object.keys(e2eApps).join(", ")}`)
	}
	return e2eApps[key](wsAdapter)
}
