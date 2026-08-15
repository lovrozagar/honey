import { honey } from "honey/plugin"

export default {
	plugins: [
		honey({
			app: "src/app.ts",
			codegen: {
				manifest: true,
				openApi: { title: "Demo 2 API", version: "1.0.0" },
				sdk: { name: "Demo2SDK" },
				tree: true,
				types: true,
			},
		}),
	],
}
