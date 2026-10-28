/**
 * A file argument's value (bit 21 c, g): the io.modelcontextprotocol/files draft's FileInput (PR head 6101d34), its data
 * canonical base64 of its size and digest, a call's inline bytes capped; a path a reading transport reads; a URL a
 * mount's fetch reads. The extension's wire shape lives here alone: its identifier, its advertisement, its upload flow
 * (a mount's uploads, a 2026-07-28 request declaring it): an input request of one `omit` target a data-less file, and
 * on the retry each file's bytes taken once by the token its requestState echoes.
 */
export const FILES = "io.modelcontextprotocol/files"

/** The extension as advertised: the inline bytes one request may carry. */
export const filesCapability = (maxInlineBytes: number) => ({ [FILES]: { maxInlineBytes } })

/** Reads a file by its path, rejecting with the rule it breaks. */
export type Read = (path: string) => Promise<Uint8Array>

/** Fetches a file by its URL: its bytes, type and name; rejecting with the rule it breaks. */
export type FetchFile = (
	url: string,
	signal: AbortSignal,
) => Promise<{ bytes: Uint8Array; type: string; name?: string }>

/* an upload's call (credential headers, tool, arguments) and file (id, size, SHA-256) */
type Scope = { credential: string; tool: string; args: Record<string, unknown> }
type Declared = { id: string; size: number; digest: string }

/**
 * A mount's uploads for one request: targets under `base/`, a file's size cap, a token, and the retry's bytes, taken
 * once; `take` rejects a token the call does not hold and resolves a missing upload's rule.
 */
export type Uploads = {
	readonly base: string
	readonly max: number
	readonly issue: (scope: Scope, file: Declared) => Promise<string>
	readonly take: (scope: Scope, file: Declared, token: string) => Promise<Uint8Array | string>
}

/** A call's files: a path reader, a URL fetch, uploads and their credential; a modern request's params and client. */
export type Files = {
	readonly read?: Read
	readonly fetch?: FetchFile
	readonly uploads?: Uploads
	readonly credential?: string
	readonly asked?: Record<string, unknown>
	readonly client?: { readonly extensions?: Record<string, unknown> }
}

/* canonical base64: whole quads, the last padded, its unused bits zero */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/

/** `text`'s bytes when it is canonical base64. */
export const decoded = (text: string): Uint8Array<ArrayBuffer> | undefined =>
	BASE64.test(text) ? Uint8Array.from(atob(text), (char) => char.charCodeAt(0)) : undefined

/** `bytes` as base64, 32 KiB at a time (no Buffer, so a Worker runs it). */
export function encoded(bytes: Uint8Array): string {
	let text = ""
	for (let at = 0; at < bytes.length; at += 32_768) text += String.fromCharCode(...bytes.subarray(at, at + 32_768))
	return btoa(text)
}

/** `bytes`' SHA-256, base64url unpadded, as a FileInput's digest is. */
export const digestOf = async (bytes: Uint8Array<ArrayBuffer>) =>
	encoded(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
		.replace(/=+$/, "")
		.replaceAll("+", "-")
		.replaceAll("/", "_")

/** An inline FileInput's bytes, `budget.left` the inline bytes still allowed; else the rule it breaks. */
async function inlined(file: Record<string, unknown>, budget: { left: number; cap: number }) {
	if (typeof file.data !== "string") return "has no data, and no upload is served here"
	const bytes = decoded(file.data)
	if (bytes === undefined) return "data is not base64"
	if ((budget.left -= bytes.length) < 0) return `is past the ${budget.cap} inline bytes a call may carry`
	if (bytes.length !== file.size) return "data does not decode to its size"
	if ((await digestOf(bytes)) !== (file.digest as { value: unknown }).value) return "data does not match its digest"
	return { bytes, ...named(file) }
}

/** A FileInput's type, and its name when it gives one. */
const named = (file: Record<string, unknown>) => ({
	type: String(file.mimeType),
	...(typeof file.name === "string" && { name: file.name }),
})

/** A FileInput as its upload binds it. */
const declared = (file: Record<string, unknown>): Declared => ({
	digest: String((file.digest as { value: unknown }).value),
	id: String(file.id),
	size: Number(file.size),
})

type Pending = readonly (readonly [label: string, value: Record<string, unknown>])[]

/** The first call's input request: one `omit` target a pending file, the tokens its requestState. */
async function asked(uploads: Uploads, scope: Scope, pending: Pending) {
	/* a whole size within the cap, a SHA-256's 43 base64url characters: no `.` in a token's fields */
	const wrong = pending.find(([, { size, ...value }]) => {
		const fits = Number.isSafeInteger(size) && (size as number) >= 0 && (size as number) <= uploads.max
		return !(fits && /^[\w-]{43}$/.test(declared(value).digest))
	})
	if (wrong)
		return `Invalid arguments: ${wrong[0]} needs a whole size within the ${uploads.max}-byte upload cap and a SHA-256`
	const tokens = await Promise.all(pending.map(([, value]) => uploads.issue(scope, declared(value))))
	const files = pending.map(([, value], at) => ({
		credentials: "omit",
		fileId: value.id,
		url: `${uploads.base}/${tokens[at]}`,
	}))
	return {
		inputRequired: {
			inputRequests: { uploads: { method: `${FILES}/upload`, params: { files } } },
			requestState: tokens.join(" "),
		},
	}
}

/** The retry's bytes: one outcome a pending file, the state one token a file in its order, each file taken once. */
async function retried(uploads: Uploads, scope: Scope, pending: Pending, params: Record<string, unknown>) {
	const answered = (params.inputResponses as { uploads?: { resultType?: unknown; files?: unknown } } | undefined)
		?.uploads
	const listed = Array.isArray(answered?.files) ? (answered.files as ({ fileId?: unknown } | null)[]) : []
	const outcomes = new Map(listed.map((each) => [each?.fileId, (each as { status?: unknown } | null)?.status]))
	const tokens = typeof params.requestState === "string" ? params.requestState.split(" ") : []
	const answers = (status: string) => pending.filter(([, value]) => outcomes.get(value.id) === status)
	const [completed, failed] = [answers("completed"), answers("failed")]
	if (
		answered?.resultType !== "complete" ||
		tokens.length !== pending.length ||
		listed.length !== pending.length ||
		completed.length + failed.length !== pending.length
	)
		return { invalid: "requestState and inputResponses.uploads answer no upload this call asked for" }
	if (failed[0]) return `Invalid arguments: ${failed[0][0]} failed to upload`
	const taken = new Map<object, Uint8Array>()
	for (const [at, [label, value]] of pending.entries()) {
		let bytes: Uint8Array | string
		try {
			bytes = await uploads.take(scope, declared(value), tokens[at] as string)
			/* a token this call does not hold is the state's refusal */
		} catch (error) {
			return { invalid: (error as Error).message }
		}
		if (typeof bytes === "string") return `Invalid arguments: ${label} ${bytes}`
		taken.set(value, bytes)
	}
	return taken
}

/** The data-less FileInputs among `values` (`[label, value]`): asked for on the call, taken on its retry. */
export function staged(tool: string, args: Record<string, unknown>, values: Pending, files: Files | undefined) {
	const { asked: params, client, credential = "", uploads } = files ?? {}
	const pending = values.filter(([, value]) => Object.hasOwn(value, "id") && value.data === undefined)
	if (uploads === undefined || pending.length === 0) return new Map<object, Uint8Array>()
	const extension = client?.extensions?.[FILES]
	if (typeof extension !== "object" || extension === null)
		return `Invalid arguments: ${pending[0]?.[0]} has no data, and an upload needs a 2026-07-28 request declaring ${FILES}`
	const ids = values.flatMap(([, value]) => (Object.hasOwn(value, "id") ? [value.id] : []))
	if (new Set(ids).size !== ids.length) return "Invalid arguments: a file id repeats"
	const scope = { args, credential, tool }
	return params?.requestState === undefined ? asked(uploads, scope, pending) : retried(uploads, scope, pending, params)
}

/** A file argument its inputSchema took: its bytes, name and type; else the rule it breaks. */
export async function fileOf(
	file: Record<string, unknown>,
	files: Files & { readonly taken: Map<object, Uint8Array>; readonly signal: AbortSignal },
	budget: { left: number; cap: number },
) {
	const uploaded = files.taken.get(file)
	if (Object.hasOwn(file, "id")) return uploaded ? { bytes: uploaded, ...named(file) } : inlined(file, budget)
	const { fetch, read } = files
	const url = Object.hasOwn(file, "url")
	if (url ? fetch === undefined : read === undefined)
		return url ? "is a URL, which this server fetches none of" : "is a path, which only the stdio server reads"
	try {
		if (url) return await (fetch as FetchFile)(String(file.url), files.signal)
		const path = String(file.path)
		return { bytes: await (read as Read)(path), name: path.split(/[/\\]/).pop(), type: "application/octet-stream" }
		/* a reader's or a fetch's refusal is its rule */
	} catch (error) {
		return (error as Error).message
	}
}
