/** `swagger(config)`: the Swagger UI page for the document at `config.url`. */
import type { TypedResponse } from "../response/response.ts"
import { type DocsConfig, type DocsContext, docsPage, inlineJson, SWAGGER_UI } from "./docs-page.ts"

export function swagger(config: DocsConfig): (ctx: DocsContext) => TypedResponse {
	const inline = inlineJson({ dom_id: "#swagger-ui", ...config })
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
  <script nonce="${nonce}">
    SwaggerUIBundle(${inline})
  </script>
</body>
</html>`,
	)
}
