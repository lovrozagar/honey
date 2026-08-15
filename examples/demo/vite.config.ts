import { honey } from "honey/plugin"

export default {
	plugins: [
		honey({
			app: "src/app.ts",
			codegen: {
				manifest: true,
				openApi: { title: "Demo API", version: "1.0.0" },
				tree: true,
				types: true,
			},
			watch: ["src/**/*.ts"],
		}),
	],
}
