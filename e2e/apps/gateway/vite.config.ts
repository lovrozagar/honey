import { honey } from "@lovrozagar/honey/plugin"

export default {
	plugins: [
		honey({
			app: "src/gen-app.ts",
			codegen: {
				manifest: true,
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
