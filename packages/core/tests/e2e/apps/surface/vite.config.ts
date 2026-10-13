import { honey } from "@lovrozagar/honey/plugin"

export default {
	plugins: [
		honey({
			app: "src/gen-app.ts",
			codegen: {
				manifest: true,
				openApi: { title: "Honey Surface", version: "1.0.0" },
				tree: true,
				types: true,
			},
		}),
	],
}
