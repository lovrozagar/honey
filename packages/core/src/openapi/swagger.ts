import type { TypedResponse } from "../response.ts"

type SwaggerOptions = {
	url: string
	[key: string]: unknown
}

export function swagger(
	options: SwaggerOptions,
): (ctx: { res: { html(sk: "ok", body: string): TypedResponse } }) => TypedResponse {
	const { url, ...rest } = options
	const config = JSON.stringify({ dom_id: "#swagger-ui", url, ...rest })

	const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Swagger UI</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle(${config})
  </script>
</body>
</html>`

	const handler = (ctx: { res: { html(sk: "ok", body: string): TypedResponse } }) => ctx.res.html("ok", html)
	Object.defineProperty(handler, Symbol.for("honey.internal"), { value: true })
	return handler
}
