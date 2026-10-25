/**
 * The TypeScript SDK front (F1): `new <Name>(config)` over the vendored runtime. Five files under
 * one stem: the class, the service map it dispatches by, the types it merges with, the runtime
 * verbatim, and the index a consumer imports. Read from the IR alone (H2).
 */
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import type { IRAuth } from "../../ir/model.ts"
import { tsString } from "../shared/escape.ts"
import { words } from "../shared/lang.ts"
import { runtimeSource } from "./http.ts"
import { sdkTypesText } from "./sdk-types.ts"
import { serviceMapText } from "./service-map.ts"

export { sdkMemberPaths, serviceMapOf } from "./service-map.ts"

export type SdkOptions = {
	/** the SDK class name, a TypeScript identifier */
	readonly name: string
	/** the file-name stem; the name kebab-cased when left out (`TestSDK` → `test-sdk`) */
	readonly stem?: string
}

export type GeneratedSdk = { readonly files: Readonly<Record<string, string>>; readonly stem: string }

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/* the error classes and helpers a consumer imports from the SDK beside the class */
const RUNTIME_EXPORTS = [
	"BadGatewayError",
	"BadRequestError",
	"ClientError",
	"ConflictError",
	"createFallbackChain",
	"createKeepaliveLoop",
	"createResumableConnection",
	"ForbiddenError",
	"GatewayTimeoutError",
	"HTTPClient",
	"InternalServerError",
	"isClientError",
	"newClientRequestId",
	"NotFoundError",
	"parseSSEStream",
	"PathParamError",
	"RateLimitError",
	"RealtimeAbortError",
	"RealtimeConnectError",
	"RealtimeError",
	"RealtimeKickedError",
	"ServiceUnavailableError",
	"UnauthorizedError",
	"UnprocessableEntityError",
]

const RUNTIME_TYPES = [
	"ClientConfig",
	"ConnectionState",
	"InvalidationConfig",
	"LogEntry",
	"RequestOptions",
	"ResumableConnection",
	"ResumableConnectionOpts",
	"ServerFrame",
	"SSEEvent",
	"Transport",
	"TransportAdapter",
	"TransportConnection",
	"TransportOpts",
	"TypedWebSocket",
]

/** `TestSDK` → `test-sdk`: the words of the name, lower case, joined by `-`. */
const kebab = (name: string) =>
	words(name)
		.map((word) => word.toLowerCase())
		.join("-")

/** The class name lands in source and the stem in import specifiers and file names: both are checked. */
function validated(options: SdkOptions): { name: string; stem: string } {
	const { name } = options
	if (!IDENTIFIER.test(name))
		throw new Error(`generateSdk: name ${JSON.stringify(name)} is not a TypeScript identifier`)
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
import type { ${name}Config, ${name}Operations } from "./${stem}.types.gen"

export class ${name}<TThrow extends boolean = false> extends SDKClient {
	constructor(config: ${name}Config<TThrow>) {
		super(serviceMap, ${config})
	}
}

/* declaration merge: the Proxy-backed class carries the typed operations */
export interface ${name}<TThrow extends boolean = false> extends ${name}Operations<TThrow> {}
`
}

function indexText(name: string, stem: string): string {
	return `export { ${name} } from "./${stem}.client.gen"
export { serviceMap } from "./${stem}.map.gen"
export type * from "./${stem}.types.gen"
export { ${RUNTIME_EXPORTS.join(", ")} } from "./${stem}.runtime.gen"
export type { ${RUNTIME_TYPES.join(", ")} } from "./${stem}.runtime.gen"
`
}

/** The SDK files for `document`, by file name, and their stem. */
export function generateSdk(document: Record<string, unknown>, options: SdkOptions): GeneratedSdk {
	const { name, stem } = validated(options)
	const ir = toIR(document as OpenApiDocument, { deriveOperationIds: true, duplicateOperationIds: "throw" })
	const runtime = `${stem}.runtime.gen`
	return {
		files: {
			[`${stem}.client.gen.ts`]: clientText(name, stem, ir.servers[0], ir.auth),
			[`${stem}.index.gen.ts`]: indexText(name, stem),
			[`${stem}.map.gen.ts`]: serviceMapText(ir, runtime),
			[`${stem}.runtime.gen.ts`]: runtimeSource(),
			[`${stem}.types.gen.ts`]: sdkTypesText(ir, name, runtime),
		},
		stem,
	}
}
