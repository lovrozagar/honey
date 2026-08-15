export type RequestToCurlOptions = {
	excludeHeader?: (name: string, value: string) => boolean
}

function shellEscape(value: string): string {
	return value.replace(/'/g, "'\\''")
}

/**
 * Convert a native Request into a curl command string.
 * The request is cloned so reading the body does not consume the original stream.
 */
export async function requestToCurl(
	request: Request,
	options?: RequestToCurlOptions,
): Promise<string> {
	const clonedRequest = request.clone()
	const parts: string[] = [`curl -X ${clonedRequest.method}`]

	for (const [name, value] of clonedRequest.headers.entries()) {
		if (options?.excludeHeader?.(name, value) === true) continue
		parts.push(`-H '${shellEscape(name)}: ${shellEscape(value)}'`)
	}

	const body = await clonedRequest.text()

	if (body.length > 0) {
		parts.push(`--data-raw '${shellEscape(body)}'`)
	}

	parts.push(`'${shellEscape(clonedRequest.url)}'`)

	return parts.join(" ")
}
