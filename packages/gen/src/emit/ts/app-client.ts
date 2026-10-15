/**
 * The app-typed front (F1): `createClient<typeof app>(config)`, vendored into an app's `_gen/`. It
 * reads the app's `$routes` phantom structurally (D3), so the files import nothing from honey.
 */
import { runtimeSource } from "./http.ts"

const VALUES = [
	"BadGatewayError",
	"BadRequestError",
	"ClientError",
	"ConflictError",
	"createClient",
	"createTypedWebSocket",
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
	"ServiceUnavailableError",
	"UnauthorizedError",
	"UnprocessableEntityError",
]

const TYPES = [
	"AuthExpiredContext",
	"ClientConfig",
	"ClientResult",
	"ErrorEnvelope",
	"FieldError",
	"HoneyClient",
	"InferRoutes",
	"OnRequestContext",
	"OnResponseContext",
	"RedirectPolicy",
	"RequestOptions",
	"SSEEvent",
	"TypedWebSocket",
]

/** `client.gen.ts` (what an app imports) and `client.runtime.gen.ts` (the runtime verbatim). */
export function generateAppClient(): { files: Readonly<Record<string, string>> } {
	const client = `export { ${VALUES.join(", ")} } from "./client.runtime.gen"
export type { ${TYPES.join(", ")} } from "./client.runtime.gen"
`
	return { files: { "client.gen.ts": client, "client.runtime.gen.ts": runtimeSource() } }
}
