/** `scalar(config)`: the Scalar API reference page for the document at `config.url`. */
import type { TypedResponse } from "../response/response.ts"
import { type DocsConfig, type DocsContext, docsPage, inlineJson, SCALAR } from "./docs-page.ts"

export function scalar(config: DocsConfig): (ctx: DocsContext) => TypedResponse {
	const inline = inlineJson(config)
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
  <script nonce="${nonce}">
    Scalar.createApiReference(document.getElementById("app"), ${inline})
  </script>
</body>
</html>`,
	)
}
