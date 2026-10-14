/**
 * `requestToCurl(request)`: the request as a `curl` command that reproduces it, for a developer to
 * paste. Faithful by default: no header is redacted, since a redacted command cannot reproduce the
 * request; `excludeHeader` leaves out what the caller names, and `curlLogger` is the redacting path
 * for logs. The request is cloned, so its body stays readable.
 */

export type RequestToCurlOptions = {
	/** Leave a header out of the command. */
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
 * One shell word. Plain values use single quotes; a value with a control character (CR, LF, ESC…)
 * uses ANSI-C `$'…'` quoting with `\xHH` escapes, so a pasted command cannot carry a raw newline
 * and a log line cannot be split.
 */
export function shellQuote(value: string): string {
	if (!hasControl(value)) return `'${value.replaceAll("'", "'\\''")}'`
	let out = "$'"
	for (const ch of value) {
		const code = ch.codePointAt(0) as number
		if (ch === "\\" || ch === "'") out += `\\${ch}`
		else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`
		else out += ch
	}
	return `${out}'`
}

export async function requestToCurl(request: Request, options: RequestToCurlOptions = {}): Promise<string> {
	const copy = request.clone()
	const parts = ["curl", "-X", shellQuote(copy.method)]
	for (const [name, value] of copy.headers) {
		if (options.excludeHeader?.(name, value) !== true) parts.push("-H", shellQuote(`${name}: ${value}`))
	}
	const body = await copy.text()
	if (body.length > 0) parts.push("--data-raw", shellQuote(body))
	parts.push(shellQuote(copy.url))
	return parts.join(" ")
}
