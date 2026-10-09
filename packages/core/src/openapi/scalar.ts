import type { TypedResponse } from "../response.ts"
import { docsPage, escapeAttribute, inlineJson, SCALAR } from "./docs-page.ts"

type ScalarOptions = {
	url: string
	[key: string]: unknown
}

export function scalar(
	options: ScalarOptions,
): (ctx: {
	res: { html(sk: "ok", body: string, opts?: { headers?: Record<string, string> }): TypedResponse }
}) => TypedResponse {
	const { url, ...rest } = options
	const config = inlineJson({ url, ...rest })

	return docsPage(
		(nonce) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API Reference</title>
</head>
<body>
  <div id="app"></div>
  <script src="${SCALAR.js.url}" integrity="${SCALAR.js.integrity}" crossorigin="anonymous"></script>
  <script nonce="${escapeAttribute(nonce)}">
    Scalar.createApiReference(document.getElementById("app"), ${config})
  </script>
</body>
</html>`,
	)
}
