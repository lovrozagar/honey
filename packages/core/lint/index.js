// Oxlint registers one plugin name; this entry publishes every honey rule.
import { rule as boundaries } from "./boundaries.js"
import { rule as contentTypeExactEssence } from "./content-type-exact-essence.js"
import { rule as noConsole } from "./no-console.js"
import { rule as noHeaderMode } from "./no-header-mode.js"
import { rule as noModuleSideEffects } from "./no-module-side-effects.js"
import { rule as noModuleState } from "./no-module-state.js"
import { rule as noV8Ignore } from "./no-v8-ignore.js"

export default {
	meta: { name: "honey" },
	rules: {
		boundaries,
		"content-type-exact-essence": contentTypeExactEssence,
		"no-console": noConsole,
		"no-header-mode": noHeaderMode,
		"no-module-side-effects": noModuleSideEffects,
		"no-module-state": noModuleState,
		"no-v8-ignore": noV8Ignore,
	},
}
