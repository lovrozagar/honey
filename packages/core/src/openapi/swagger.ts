import type { TypedResponse } from "../response.ts"
import { docsPage, escapeAttribute, inlineJson, SWAGGER_UI } from "./docs-page.ts"

type SwaggerOptions = {
	url: string
	[key: string]: unknown
}

export function swagger(
	options: SwaggerOptions,
): (ctx: {
	res: { html(sk: "ok", body: string, opts?: { headers?: Record<string, string> }): TypedResponse }
}) => TypedResponse {
	const { url, ...rest } = options
	const config = inlineJson({ dom_id: "#swagger-ui", url, ...rest })

	return docsPage(
		(nonce) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Swagger UI</title>
  <link rel="stylesheet" href="${SWAGGER_UI.css.url}" integrity="${SWAGGER_UI.css.integrity}" crossorigin="anonymous" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${SWAGGER_UI.js.url}" integrity="${SWAGGER_UI.js.integrity}" crossorigin="anonymous"></script>
  <script nonce="${escapeAttribute(nonce)}">
    SwaggerUIBundle(${config})
  </script>
</body>
</html>`,
	)
}
