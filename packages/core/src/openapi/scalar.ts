import type { TypedResponse } from "../response.ts"

type ScalarOptions = {
	url: string
	[key: string]: unknown
}

export function scalar(
	options: ScalarOptions,
): (ctx: { res: { html(sk: "ok", body: string): TypedResponse } }) => TypedResponse {
	const { url, ...rest } = options
	const config = JSON.stringify({ url, ...rest })

	const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API Reference</title>
</head>
<body>
  <div id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  <script>
    Scalar.createApiReference(document.getElementById("app"), ${config})
  </script>
</body>
</html>`

	const handler = (ctx: { res: { html(sk: "ok", body: string): TypedResponse } }) => ctx.res.html("ok", html)
	Object.defineProperty(handler, Symbol.for("honey.internal"), { value: true })
	return handler
}
