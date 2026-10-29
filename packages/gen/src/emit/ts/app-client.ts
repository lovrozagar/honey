/**
 * The app-typed front (F1): `createClient<typeof app>(config)`, vendored into an app's `_gen/`. It
 * reads the app's `$routes` phantom structurally (D3), so the files import nothing from honey.
 */
import { runtimeSource } from "./http.ts"

const VALUES = [
	"APIConnectionError",
	"BadGatewayError",
	"BadRequestError",
	"ClientError",
	"ConflictError",
	"createClient",
	"createFallbackChain",
	"createKeepaliveLoop",
	"createResumableConnection",
	"createTypedWebSocket",
	"DecodeError",
	"ForbiddenError",
	"GatewayTimeoutError",
	"HTTPClient",
	"InternalServerError",
	"interpolatePath",
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

const TYPES = [
	"AuthExpiredContext",
	"ClientConfig",
	"ConnectionState",
	"ErrorEnvelope",
	"FieldError",
	"HoneyClient",
	"InferRoutes",
	"LogEntry",
	"OnRequestContext",
	"OnResponseContext",
	"RealtimeOptions",
	"RedirectPolicy",
	"RequestOptions",
	"Result",
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

/** `client.gen.ts` (what an app imports) and `client.runtime.gen.ts` (the runtime verbatim). */
export function generateAppClient(): { files: Readonly<Record<string, string>> } {
	const client = `export { ${VALUES.join(", ")} } from "./client.runtime.gen"
export type { ${TYPES.join(", ")} } from "./client.runtime.gen"
`
	return { files: { "client.gen.ts": client, "client.runtime.gen.ts": runtimeSource() } }
}
