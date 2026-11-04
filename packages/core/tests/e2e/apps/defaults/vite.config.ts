import { honeyPlugin } from "@lovrozagar/honey/plugin"

export default {
	plugins: [
		honeyPlugin({
			app: "src/gen-app.ts",
			codegen: {
				manifest: true,
				openApi: { title: "Honey Defaults", version: "0.0.1" },
				tree: true,
				types: true,
			},
		}),
	],
}
