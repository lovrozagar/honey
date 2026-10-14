/**
 * Checking what a route answers against its `.output()` (off by default). An answer of a media
 * type the route does not declare is a 500 `output_content_type_mismatch`, compared by exact
 * essence (H18.2). A JSON body is checked against its status's schema, read from the raw body the
 * answer was built from, never by cloning it (H18.1); a stream honey produced is never buffered.
 * Any other declared type is a type contract only (F8). Failures are a 500 that names the status
 * key and nothing of the issues.
 */
import { EK, HoneyError } from "../errors/error.ts"
import type { MaybePromise } from "../middleware/middleware.ts"
import { isHoneyResponse, isProducedStream, rawBodyOf } from "../response/builder.ts"
import { parseMediaType } from "../response/media-type.ts"
import { codeToStatusKey } from "../response/status.ts"
import type { OutputSchemas, StatusSchemas } from "../routing/output-types.ts"
import type { StandardSchemaLike, StandardSchemaResult } from "./standard-schema.ts"

/** Whether `.output()` routes check their answers: never, always, or outside production. */
export type OutputValidationMode = "always" | "dev" | "off"

type ProcessLike = { readonly env?: { readonly NODE_ENV?: string | undefined } } | undefined

/**
 * Whether `mode` checks answers here. `"dev"` checks unless NODE_ENV is `production`, and checks
 * nothing where there is no `process` to read it from (Workers): never a cost where it cannot be
 * turned off.
 */
export function outputValidationOn(mode: OutputValidationMode, runtime: ProcessLike): boolean {
	if (mode !== "dev") return mode === "always"
	return runtime !== undefined && runtime.env?.NODE_ENV !== "production"
}

function failed(statusKey: string): HoneyError {
	return new HoneyError({ errorKey: EK.output_validation_failed, status: "internal_server_error", vars: { statusKey } })
}

function checked(result: StandardSchemaResult, statusKey: string): void {
	if (result.issues !== undefined) throw failed(statusKey)
}

/**
 * Check `data` against the schema for `statusKey`: nothing back when it passes, a promise only for
 * an async validator. A failure is a 500 `output_validation_failed` naming the status key; the
 * issues stay server-side.
 */
export function validateOutput(
	schema: StandardSchemaLike,
	statusKey: string,
	data: unknown,
): Promise<void> | undefined {
	const result = schema["~standard"].validate(data)
	if (result instanceof Promise) return result.then((r) => checked(r, statusKey))
	checked(result, statusKey)
	return undefined
}

/** A route's compiled check: the answer back as it was, or the failure. */
export type OutputCheck = (response: Response) => MaybePromise<Response>

// per-process-constant: text-codec
const decoder = /* @__PURE__ */ new TextDecoder()

function parse(raw: string | Uint8Array): unknown {
	return JSON.parse(typeof raw === "string" ? raw : decoder.decode(raw)) as unknown
}

/**
 * Whether `response` carries no body, read from how it was built, never from `.body` (a stream on
 * Node). An empty raw body is none, as `json(undefined)` is on the fetch path.
 */
function bodiless(response: Response): boolean {
	const raw = rawBodyOf(response)
	if (raw != null) return raw.length === 0
	if (isProducedStream(response)) return false
	return isHoneyResponse(response) || response.body === null
}

/**
 * The check for a route declaring `schemas`, for an app whose mode is on. The declared media types
 * are fixed here, once; `redirect` and `headers` name no body type.
 */
export function compileOutput(schemas: OutputSchemas): OutputCheck {
	const declared = new Set<string>()
	for (const key of Object.keys(schemas)) {
		const mt = key.includes("/") ? parseMediaType(key) : null
		if (mt !== null) declared.add(mt.essence)
	}
	const json = (schemas as Record<string, StatusSchemas | undefined>)["application/json"]
	return (response) => {
		if (bodiless(response)) return response
		const type = response.headers.get("content-type")
		if (type === null) return response
		const essence = parseMediaType(type)?.essence
		if (essence === undefined || !declared.has(essence)) {
			throw new HoneyError({ errorKey: EK.output_content_type_mismatch, status: "internal_server_error" })
		}
		if (essence !== "application/json" || json === undefined || isProducedStream(response)) return response
		const statusKey = codeToStatusKey[response.status]
		const schema = statusKey === undefined ? undefined : json[statusKey]
		if (schema === undefined || schema === true) return response
		const raw = rawBodyOf(response)
		if (raw !== null) {
			const pending = validateOutput(schema, statusKey as string, parse(raw))
			return pending === undefined ? response : pending.then(() => response)
		}
		/* a body honey did not build: read a copy, hand the client the original */
		return response
			.clone()
			.json()
			.then((data: unknown) => validateOutput(schema, statusKey as string, data))
			.then(() => response)
	}
}

/** `handler` with `check` on what it answers: synchronously when the handler and the check are. */
export function withOutput(
	check: OutputCheck,
	handler: (ctx: object) => MaybePromise<Response>,
): (ctx: object) => MaybePromise<Response> {
	/* a handler that answered nothing is the chain's to report: no check on what is not there */
	return (ctx) => {
		const answer = handler(ctx)
		if (answer instanceof Promise) return answer.then((response) => (response == null ? response : check(response)))
		return answer == null ? answer : check(answer)
	}
}
