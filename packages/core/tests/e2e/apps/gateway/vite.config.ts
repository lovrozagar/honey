import { honey } from "@lovrozagar/honey/plugin"

export default {
	plugins: [
		honey({
			app: "src/gen-app.ts",
			codegen: {
				manifest: true,
				/* downstream routes; the gateway's own routes are added from the app */
				mergeTree: "src/route-tree.ts",
				/* two documents from one metaSpec policy — see src/app.ts */
				openApi: [
					{ title: "Honey Gateway", version: "0.0.1" },
					{
						path: "src/_gen/openapi.public.gen.json",
						profile: "public",
						title: "Honey Gateway (public)",
						version: "0.0.1",
					},
				],
				tree: true,
				types: true,
			},
		}),
	],
}
