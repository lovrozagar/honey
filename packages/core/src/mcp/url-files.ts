/**
 * `urlFiles(options)` (bit 21 g, H24.5), `@lovrozagar/honey/mcp/url-files`: a mounted tool's file argument given as
 * `{url}`, fetched by the app, handed to `mcp(app, path, handler, { urlFiles: urlFiles(options) })`. Off unless
 * imported and passed (H23); a mount without it shows no `{url}` value and refuses one. The guards, each its rule:
 * - **the host** is one the list names exactly (its port too, when not 443); an entry `*.example.com` names every
 *   host under example.com, never example.com itself, and nothing else matches by suffix. The list holds names alone:
 *   an IP literal is refused when the list is made, in any form the URL parser reads as one (decimal, octal, hex,
 *   IPv4-mapped IPv6), so no private, loopback or link-local address is ever listed;
 * - **https** alone, with no userinfo;
 * - **no redirect**, to any host: a 3xx is the refusal (an allowed host that redirects is not followed to another);
 * - **the size**, counted as the body streams, past `maxBytes` refused (Content-Length never trusted);
 * - **the time**, headers and body together, past `timeoutMs` refused;
 * - **no credential** of the request is sent: the fetch carries no header of its own.
 * DNS is not resolved here. The hosts are the operator's own choice, so their names are trusted as far as their
 * owners are: a listed host whose DNS points at a private address is the operator's to not list. Resolving first
 * would not close it either, since fetch resolves again (rebinding), and fetch cannot be pinned to an address on
 * Workers or Bun. Workers' fetch reaches no private range at all.
 */
import type { McpFileFetch } from "./mount.ts"

/** The options of `urlFiles()`. */
export type McpUrlFilesOptions = {
	/** the hosts files are fetched from, each exact (`files.example.com`, `files.example.com:8443`) or `*.example.com` */
	readonly hosts: readonly string[]
	/** the most bytes a file may hold: 50 MiB by default */
	readonly maxBytes?: number
	/** how long a fetch may take, headers and body, in ms: 30 s by default */
	readonly timeoutMs?: number
	/** the fetch it runs: the platform's by default */
	readonly fetch?: (request: Request) => Promise<Response>
}

/* an IPv4 literal as the URL parser writes every form of one, or an IPv6 literal */
const LITERAL = /^(?:\d+\.\d+\.\d+\.\d+|\[.*\])$/

/** A refusal of `urlFiles()`'s options, saying why. */
const refuse = (why: string) => new Error(`urlFiles(): ${why}`)

/** `entry`'s host as a URL's `host` reads it: lower case, its default port dropped; refused when it is no bare name. */
function hostOf(entry: string): string {
	const url = /^[^/@?#\\\s]+$/.test(entry) && URL.canParse(`https://${entry}`) ? new URL(`https://${entry}`) : undefined
	if (url === undefined) throw refuse(`hosts names ${entry}, which is no host`)
	if (LITERAL.test(url.hostname)) throw refuse(`hosts names ${entry}, an IP address; list hosts by name`)
	return url.host
}

/** `answer`'s body, at most `max` bytes counted as it streams; refused past it, or when the answer is no 200. */
async function bodyOf(answer: Response, max: number): Promise<Uint8Array> {
	if (answer.status !== 200) {
		await answer.body?.cancel()
		const redirect = answer.status >= 300 && answer.status < 400 ? ", a redirect, which is never followed" : ""
		throw new Error(`answered ${answer.status}${redirect}`)
	}
	const chunks: Uint8Array[] = []
	let size = 0
	const reader = answer.body?.getReader()
	for (let read = await reader?.read(); read && !read.done; read = await reader?.read()) {
		if ((size += read.value.length) > max) {
			await reader?.cancel()
			throw new Error(`is past the ${max}-byte cap`)
		}
		chunks.push(read.value)
	}
	return new Uint8Array(await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer())
}

/** The URL file fetch for `mcp()`'s `urlFiles`: `options` refused now when they cannot work. */
export function urlFiles(options: McpUrlFilesOptions): McpFileFetch {
	const { maxBytes = 52_428_800, timeoutMs = 30_000 } = options
	if (options.hosts.length === 0) throw refuse("hosts lists no host")
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw refuse("maxBytes is no whole number of bytes")
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw refuse("timeoutMs is no whole number of milliseconds")
	const exact = new Set<string>()
	const under: string[] = []
	for (const entry of options.hosts)
		if (entry.startsWith("*.")) under.push(`.${hostOf(entry.slice(2))}`)
		else exact.add(hostOf(entry))
	const fetcher = options.fetch ?? ((request: Request) => fetch(request))
	/** `value` as a URL this fetch may read: https, no userinfo, on a listed host */
	const allowed = (value: string): URL => {
		const url = URL.canParse(value) ? new URL(value) : undefined
		if (url?.protocol !== "https:" || url.username !== "" || url.password !== "")
			throw new Error("is no https URL, or carries userinfo")
		if (!exact.has(url.host) && !under.some((suffix) => url.host.endsWith(suffix)))
			throw new Error(`is on ${url.host}, a host this server fetches no file from`)
		return url
	}
	return async (value, signal) => {
		const url = allowed(value)
		const timeout = AbortSignal.timeout(timeoutMs)
		try {
			const answer = await fetcher(new Request(url, { redirect: "manual", signal: AbortSignal.any([signal, timeout]) }))
			const bytes = await bodyOf(answer, maxBytes)
			const name = url.pathname.split("/").pop()
			return { bytes, type: answer.headers.get("content-type") ?? "application/octet-stream", ...(name && { name }) }
			/* a fetch the clock aborted says so; any other refusal is its own */
		} catch (error) {
			if (timeout.aborted) throw new Error(`took longer than ${timeoutMs} ms`, { cause: error })
			throw error
		}
	}
}
