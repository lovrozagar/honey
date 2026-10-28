import { honey } from "@lovrozagar/honey/plugin"

/* Anyrow's public scheme: an API key in Authorization, its prefix in the description */
const apiKey = {
	description: "API key authentication. Format: ApiKey {your_api_key}",
	in: "header",
	name: "Authorization",
	type: "apiKey",
}

export default {
	plugins: [
		honey({
			app: "src/gen-app.ts",
			codegen: {
				mcp: true,
				openApi: { securitySchemes: { apiKey }, title: "Honey MCP", version: "1.0.0" },
				tree: true,
			},
		}),
	],
}
