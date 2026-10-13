export type RequestToCurlOptions = {
	excludeHeader?: (name: string, value: string) => boolean
}

function hasControl(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		if (code < 0x20 || code === 0x7f) return true
	}
	return false
}

/**
 * Quote one shell word. Plain values use single quotes; values with control
 * characters (CR, LF, ESC, …) use ANSI-C `$'…'` quoting with `\xHH` escapes, so
 * a pasted command cannot carry a raw newline and a log line cannot be split.
 */
export function shellQuote(value: string): string {
	if (!hasControl(value)) return `'${value.replace(/'/g, "'\\''")}'`
	let out = "$'"
	for (const ch of value) {
		const code = ch.codePointAt(0) as number
		if (ch === "\\" || ch === "'") out += `\\${ch}`
		else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`
		else out += ch
	}
	return `${out}'`
}

/**
 * Convert a native Request into a curl command string. Every word is quoted.
 * The request is cloned so reading the body does not consume the original stream.
 */
export async function requestToCurl(request: Request, options?: RequestToCurlOptions): Promise<string> {
	const clonedRequest = request.clone()
	const parts: string[] = ["curl", "-X", shellQuote(clonedRequest.method)]

	for (const [name, value] of clonedRequest.headers.entries()) {
		if (options?.excludeHeader?.(name, value) === true) continue
		parts.push("-H", shellQuote(`${name}: ${value}`))
	}

	const body = await clonedRequest.text()

	if (body.length > 0) {
		parts.push("--data-raw", shellQuote(body))
	}

	parts.push(shellQuote(clonedRequest.url))

	return parts.join(" ")
}
