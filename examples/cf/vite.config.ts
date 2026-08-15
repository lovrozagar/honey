import { honey } from "honey/plugin"

export default {
	plugins: [
		honey({
			entry: "src/index.ts",
			manifest: true,
			openApi: { title: "Honey CF", version: "0.1.0" },
			tree: true,
			types: true,
		}),
	],
}
