import { honey } from "honey/plugin"

export default {
	plugins: [
		honey({
			app: "src/app.ts",
			codegen: {
				manifest: true,
				openApi: { title: "Demo 3", version: "0.0.1" },
				tree: true,
				types: true,
			},
		}),
	],
}
