/**
 * The TypeScript SDK front (F1): `new <Name>(config)` over the vendored runtime. Five files under
 * one stem: the class, the service map it dispatches by, the types it merges with, the runtime
 * verbatim, and the index a consumer imports; a sixth for a document with Standard Webhooks events,
 * `verifyWebhook` on its own so a receiver imports nothing else. Read from the IR alone (H2).
 */
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import type { IRAuth } from "../../ir/model.ts"
import { tsString } from "../shared/escape.ts"
import { compareCodeUnits, words } from "../shared/lang.ts"
import { MIRROR, mirrorNotice } from "../shared/mirror.ts"
import { runtimeFeatures, runtimeSource, type TsRuntimeFeatures } from "./http.ts"
import { RESERVED } from "./sdk-types-preamble.ts"
import { sdkTypesText } from "./sdk-types.ts"
import { tanstackQueryText } from "./tanstack-query.ts"
import { memberTree, serviceMapText } from "./service-map.ts"
import { webhooksText, webhookTypeNames } from "./webhooks.ts"

export { sdkMemberPaths, serviceMapOf } from "./service-map.ts"

export type SdkOptions = {
	/** the SDK class name, a TypeScript identifier */
	readonly name: string
	/** the file-name stem; the name kebab-cased when left out (`TestSDK` → `test-sdk`) */
	readonly stem?: string
	/** also write `<stem>.tanstack-query.gen.ts`; `@tanstack/query-core` is then the consumer's own peer */
	readonly tanstackQuery?: boolean
}

/** The SDK's files, its stem, and what the generation tells its caller: a root group renamed off the safe mirror. */
export type GeneratedSdk = {
	readonly files: Readonly<Record<string, string>>
	readonly notices: readonly string[]
	readonly stem: string
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/* the error classes and helpers a consumer imports from the SDK beside the class, by the transport that ships them */
const RUNTIME_EXPORTS = {
	core: [
		"APIConnectionError",
		"BadGatewayError",
		"BadRequestError",
		"ClientError",
		"ConflictError",
		"DecodeError",
		"ForbiddenError",
		"GatewayTimeoutError",
		"HTTPClient",
		"InternalServerError",
		"isClientError",
		"newClientRequestId",
		"NotFoundError",
		"PathParamError",
		"RateLimitError",
		"ServiceUnavailableError",
		"UnauthorizedError",
		"UnprocessableEntityError",
	],
	realtime: [
		"createFallbackChain",
		"createKeepaliveLoop",
		"createResumableConnection",
		"RealtimeAbortError",
		"RealtimeConnectError",
		"RealtimeError",
		"RealtimeKickedError",
	],
	sse: ["parseSSEStream"],
	ws: [],
} as const satisfies Record<"core" | "realtime" | "sse" | "ws", readonly string[]>

const RUNTIME_TYPES = {
	core: ["ClientConfig", "InvalidationConfig", "LogEntry", "RequestOptions", "Result"],
	realtime: [
		"ConnectionState",
		"RealtimeOptions",
		"ResumableConnection",
		"ResumableConnectionOpts",
		"ServerFrame",
		"Transport",
		"TransportAdapter",
		"TransportConnection",
		"TransportOpts",
	],
	sse: ["SSEEvent"],
	ws: ["TypedWebSocket"],
} as const satisfies Record<"core" | "realtime" | "sse" | "ws", readonly string[]>

/** The names of `lists` a runtime with `features` ships, ignoring case in their order. */
function shipped(lists: Record<"core" | "realtime" | "sse" | "ws", readonly string[]>, features: TsRuntimeFeatures) {
	const realtime = features.realtime
	const groups = [lists.core, features.sse || realtime ? lists.sse : [], features.ws || realtime ? lists.ws : []]
	return [...groups, realtime ? lists.realtime : []]
		.flat()
		.sort((a, b) => compareCodeUnits(a.toLowerCase(), b.toLowerCase()))
}

/** `TestSDK` → `test-sdk`: the words of the name, lower case, joined by `-`. */
const kebab = (name: string) =>
	words(name)
		.map((word) => word.toLowerCase())
		.join("-")

/**
 * Whether `own` is a name the runtime of any features shares with the index, or one the client file imports and the
 * index re-exports beside the class.
 */
const runtimeOwns = (own: string) =>
	["SDKClient", "schemeAuth", "serviceMap"].includes(own) ||
	[RUNTIME_EXPORTS, RUNTIME_TYPES].some((lists) => Object.values(lists).some((names) => names.includes(own)))

/** The names the SDK `name` declares: the class, then the types file's three. */
const ownNames = (name: string) => [name, `${name}Config`, `${name}Operations`, `${name}Safe`]

/**
 * Refuses a name whose class or derived types clash with a name the files already use, `taken` saying whose.
 * `${name}Config` may be `SDKConfig`: the types file then imports the runtime's own under another name.
 */
function refuseClash(name: string, taken: (own: string) => string | undefined): void {
	for (const own of ownNames(name)) {
		if (own === "SDKConfig" && own !== name) continue
		const owner = taken(own)
		if (owner === undefined) continue
		const subject =
			own === name ? `name ${JSON.stringify(name)} is` : `name ${JSON.stringify(name)} declares ${own}, which is`
		throw new Error(`generateSdk: ${subject} a name ${owner} already uses; choose another name (--ts-name)`)
	}
}

/** The class name lands in source and the stem in import specifiers and file names: both are checked. */
function validated(options: SdkOptions): { name: string; stem: string } {
	const { name } = options
	if (!IDENTIFIER.test(name))
		throw new Error(`generateSdk: name ${JSON.stringify(name)} is not a TypeScript identifier`)
	refuseClash(name, (own) =>
		runtimeOwns(own) ? "the SDK's runtime" : RESERVED.includes(own) ? "the SDK's types" : undefined,
	)
	const stem = options.stem ?? kebab(name)
	if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(stem)) {
		throw new Error(
			`generateSdk: stem ${JSON.stringify(stem)} must be a plain file name (letters, digits, ".", "_", "-")`,
		)
	}
	return { name, stem }
}

/**
 * The class: the runtime's `SDKClient` over the service map, merged with the operations' interface.
 * A config without `baseURL` sends to `server`, the document's first one, when it declares any; its auth header
 * pair defaults to the API's scheme (`auth`), as every sibling SDK's does.
 */
function clientText(name: string, stem: string, server: string | undefined, auth: IRAuth): string {
	const based = server === undefined ? "config" : `{ ...config, baseURL: config.baseURL ?? ${tsString(server)} }`
	const config = `schemeAuth(${based}, ${tsString(auth.headerName)}, ${tsString(auth.prefix)})`
	return `import { SDKClient, schemeAuth } from "./${stem}.runtime.gen"
import { serviceMap } from "./${stem}.map.gen"
import type { ${name}Config, ${name}Operations, ${name}Safe } from "./${stem}.types.gen"

export class ${name} extends SDKClient {
	constructor(config: ${name}Config) {
		super(serviceMap, ${config})
	}
}

/* declaration merge: the Proxy-backed class carries the typed operations, and their safe twins */
export interface ${name} extends ${name}Operations {
	readonly safe: ${name}Safe
}
`
}

function indexText(name: string, stem: string, features: TsRuntimeFeatures): string {
	return `export { ${name} } from "./${stem}.client.gen"
export { serviceMap } from "./${stem}.map.gen"
export type * from "./${stem}.types.gen"
export { ${shipped(RUNTIME_EXPORTS, features).join(", ")} } from "./${stem}.runtime.gen"
export type { ${shipped(RUNTIME_TYPES, features).join(", ")} } from "./${stem}.runtime.gen"
`
}

/** The SDK files for `document`, by file name, and their stem. */
export function generateSdk(document: Record<string, unknown>, options: SdkOptions): GeneratedSdk {
	const { name, stem } = validated(options)
	const ir = toIR(document as OpenApiDocument, { deriveOperationIds: true, duplicateOperationIds: "throw" })
	const events = new Set(webhookTypeNames(ir))
	refuseClash(name, (own) => (events.has(own) ? "the document's webhook events" : undefined))
	const runtime = `${stem}.runtime.gen`
	const features = runtimeFeatures(ir)
	/* memberTree emits the root groups in code-unit order, each renamed in place */
	const emitted = [...memberTree(ir.tree).entries.keys()]
	const groups = [...ir.tree.entries.keys()].sort(compareCodeUnits)
	const notices = groups.flatMap((group, i) => mirrorNotice("ts", MIRROR, group, emitted[i] as string) ?? [])
	const files: Record<string, string> = {
		[`${stem}.client.gen.ts`]: clientText(name, stem, ir.servers[0], ir.auth),
		[`${stem}.index.gen.ts`]: indexText(name, stem, features),
		[`${stem}.map.gen.ts`]: serviceMapText(ir, runtime),
		[`${stem}.runtime.gen.ts`]: runtimeSource(features),
		[`${stem}.types.gen.ts`]: sdkTypesText(ir, name, runtime),
	}
	if (ir.webhooks.some((webhook) => webhook.event)) files[`${stem}.webhook.gen.ts`] = webhooksText(ir, stem)
	/* the index never names it: its text must not vary by option, and it must never name query-core */
	if (options.tanstackQuery === true) files[`${stem}.tanstack-query.gen.ts`] = tanstackQueryText(ir, name, stem)
	return { files, notices, stem }
}
