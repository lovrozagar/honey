import { honey } from "honey/plugin"

export default {
	plugins: [
		honey({
			app: "src/index.ts",
			codegen: {
				manifest: true,
				openApi: { title: "Honey CF", version: "0.1.0" },
				tree: true,
				types: true,
			},
		}),
	],
}
