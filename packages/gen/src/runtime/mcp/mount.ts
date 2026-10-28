/**
 * MCP mounted in the app itself (bit 21 e), web-standard: each request served over http.ts by tools bound to an SDK
 * client of its own, whose fetch dispatches in-process to the app. Only the request headers its security schemes name
 * go on each inner request, and only to the app's own origin: a call off it is refused, never sent. An inner 401, or
 * a 403 for insufficient_scope, is the endpoint's own answer with its challenge, never a tool's result.
 */
import { bindTools, type SdkClient, type ToolSpec } from "./call.ts"
import { serveHttp } from "./http.ts"
import { createProtocol, type ServerInfo } from "./protocol.ts"
import { BYTES_MAX } from "./result.ts"

/** The SDK config a mounted call runs under. */
export type MountConfig = {
	readonly baseURL: string
	readonly fetch: typeof fetch
	readonly maxResponseBytes: number
	readonly onResponse?: (() => undefined)[]
	readonly redirect: "same-origin"
	readonly throwOnError: false
	readonly timeout: number
}

/** What a mount hands each request: the in-process dispatch, the origins served beside its own, the body cap. */
export type Mount = {
	readonly dispatch: (request: Request) => Promise<Response>
	readonly origins?: readonly string[]
	readonly max?: number
}

/** The generated handler: whether any tool's operation needs a credential, the scheme a 401 names, the endpoint. */
export type Mounted = {
	readonly secured: boolean
	readonly challenge: string
	readonly fetch: (request: Request, mount: Mount) => Promise<Response>
}

/** A mounted server: its tools and SDK, the credential headers, its server path, a call's bound in ms. */
export type Mounting = {
	readonly info: ServerInfo
	readonly specs: readonly ToolSpec[]
	readonly client: (config: MountConfig) => SdkClient
	readonly credentials: readonly string[]
	readonly secured: boolean
	readonly challenge: string
	readonly server: string
	readonly timeout?: number
}

/** The handler serving `mounting`'s tools at a mount. */
export function mountedMcp(mounting: Mounting): Mounted {
	const { challenge, client, credentials, info, secured, server, specs, timeout = 30_000 } = mounting
	return {
		challenge,
		fetch: async (request, { dispatch, max, origins }) => {
			const origin = new URL(request.url).origin
			const carried = credentials.flatMap((name) => {
				const value = request.headers.get(name)
				return value === null ? [] : [[name, value] as const]
			})
			let refused: Response | undefined
			const inner = async (input: RequestInfo | URL, init?: RequestInit) => {
				const sent = new Request(input, init)
				if (new URL(sent.url).origin !== origin) throw new TypeError("Refused: a call off this app's origin")
				for (const [name, value] of carried) sent.headers.set(name, value)
				const answer = await dispatch(sent)
				const scope = answer.status === 403 && /insufficient_scope/.test(answer.headers.get("www-authenticate") ?? "")
				if (answer.status === 401 || scope) refused ??= answer
				return answer
			}
			const config: MountConfig = {
				baseURL: origin + server,
				fetch: inner as typeof fetch,
				maxResponseBytes: BYTES_MAX,
				redirect: "same-origin",
				throwOnError: false,
				timeout,
			}
			const tools = bindTools(specs, client(config), {
				opening: (seen) => client({ ...config, onResponse: [() => void seen()] }),
				/* each credential as sent, and its token after the scheme */
				secrets: carried.flatMap(([, value]) => [value, value.replace(/^\S+ +/, "")]),
				timeout,
			})
			const answer = await serveHttp(createProtocol(info, tools), { max, origins })(request)
			if (refused === undefined) return answer
			await answer.body?.cancel()
			const named = refused.headers.get("www-authenticate") ?? challenge
			return new Response(null, { headers: { "www-authenticate": named }, status: refused.status })
		},
		secured,
	}
}
