import { honey } from "@ecomet/honey/plugin"

export default {
	plugins: [
		honey({
			entry: "src/app.ts",
			export: "app",
			manifest: true,
			openApi: { title: "Demo 2 API", version: "1.0.0" },
			sdk: { name: "Demo2SDK" },
			tree: true,
			types: true,
		}),
	],
}
