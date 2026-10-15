/**
 * An operation's responses: each declared answer by status and media type, its redirects and the
 * headers each status declares, then the errors the route may answer in the app's error format.
 * honey's envelope names a status's keys and status as enums; Problem Details (RFC 9457) names the
 * keys' type URIs. A schema error documents its own body, under JSON, in either format.
 */
import { compareCodeUnits } from "../schema/canonicalize.ts"
import type { JsonSchema } from "../schema/to-json-schema.ts"
import type { ErrorFormat } from "../errors/problem-json.ts"
import { type StatusKey, statusKeyToCode } from "../response/status.ts"
import type { OutputSchemas, StatusSchemas } from "../routing/output-types.ts"
import type { CollectedError } from "./collect.ts"

export type MediaObject = { schema?: JsonSchema }
export type HeaderObject = { description?: string; required?: boolean; schema: JsonSchema }
export type ResponseObject = {
	content?: Record<string, MediaObject>
	description: string
	headers?: Record<string, HeaderObject>
}

/** A schema converted for this operation: `hint` names a component it lifts. */
export type Convert = (schema: unknown, io: "input" | "output", hint: string) => JsonSchema

/** The app's error settings, their schemas already converted. */
export type ErrorSettings = {
	readonly customErrorSchema: JsonSchema | null
	readonly errorFormat: ErrorFormat
	readonly errorSchema: JsonSchema | null
}

const NOT_MEDIA: readonly string[] = ["headers", "redirect"]
const LOCATION: HeaderObject = { description: "Redirect target URL", schema: { format: "uri", type: "string" } }
const STRING = { type: "string" }

const describe = (statusKey: string) => statusKey.replaceAll("_", " ")

/** The response at `code`, created with `description` when the route has none there yet. */
function at(out: Record<string, ResponseObject>, code: number, description: string): ResponseObject {
	const key = String(code)
	out[key] ??= { description }
	return out[key]
}

/** The header objects of an object schema: one per property, required when the schema says. */
function headersOf(schema: JsonSchema): Record<string, HeaderObject> {
	const properties = (schema.properties ?? {}) as Record<string, JsonSchema>
	const required = (schema.required ?? []) as string[]
	return Object.fromEntries(
		Object.entries(properties).map(([name, property]) => [
			name,
			{ required: required.includes(name), schema: property },
		]),
	)
}

/** Every answer `output` declares, with its headers and redirects. */
export function successResponses(
	output: OutputSchemas | null,
	convert: Convert,
	hint: (code: number) => string,
): Record<string, ResponseObject> {
	const out: Record<string, ResponseObject> = {}
	if (output === null) return out
	for (const [media, statuses] of Object.entries(output)) {
		if (NOT_MEDIA.includes(media)) continue
		for (const [statusKey, schema] of Object.entries(statuses as StatusSchemas)) {
			const code = statusKeyToCode[statusKey as StatusKey]
			const response = at(out, code, describe(statusKey))
			response.content ??= {}
			response.content[media] = schema === true ? {} : { schema: convert(schema, "output", hint(code)) }
		}
	}
	for (const statusKey of Object.keys(output.redirect ?? {})) {
		at(out, statusKeyToCode[statusKey as StatusKey], describe(statusKey)).headers = { Location: LOCATION }
	}
	for (const [statusKey, schema] of Object.entries(output.headers ?? {})) {
		const code = statusKeyToCode[statusKey as StatusKey]
		const declared = headersOf(convert(schema, "output", `${hint(code)}Headers`))
		const response = at(out, code, describe(statusKey))
		/* a declared location says more than the default */
		const kept = Object.hasOwn(declared, "location") ? {} : (response.headers ?? {})
		response.headers = { ...kept, ...declared }
	}
	return out
}

const FIELD_ERRORS: JsonSchema = {
	additionalProperties: {
		items: {
			properties: { error_key: STRING, message: STRING, path: STRING },
			required: ["error_key", "message", "path"],
			type: "object",
		},
		type: "array",
	},
	type: "object",
}

/** honey's envelope, as every standard error answers by default. */
export function defaultEnvelope(): JsonSchema {
	return {
		properties: {
			error_key: { ...STRING },
			fields: structuredClone(FIELD_ERRORS),
			message: { ...STRING },
			status: { type: "integer" },
			status_key: { ...STRING },
			success: { const: false },
		},
		required: ["error_key", "fields", "message", "status", "status_key", "success"],
		type: "object",
	}
}

/** `schema` with `error_key` and `status` narrowed to `keys` and `code`, where it has them. */
function narrowed(schema: JsonSchema, keys: readonly string[], code: number): JsonSchema {
	const out = structuredClone(schema)
	const properties = out.properties as Record<string, unknown> | undefined
	if (properties?.error_key !== undefined) properties.error_key = { enum: [...keys], type: "string" }
	if (properties?.status !== undefined) properties.status = { enum: [code], type: "integer" }
	return out
}

/** A Problem Details document for standard errors `keys` at `code`. */
function problem(keys: readonly string[], code: number): JsonSchema {
	return {
		properties: {
			detail: { ...STRING },
			errors: structuredClone(FIELD_ERRORS),
			instance: { ...STRING },
			status: { enum: [code], type: "integer" },
			title: { ...STRING },
			type: { enum: keys.map((key) => `https://honey.dev/errors/${key}`), type: "string" },
		},
		required: ["detail", "status", "title", "type"],
		type: "object",
	}
}

const oneOrOneOf = (schemas: readonly JsonSchema[]): JsonSchema =>
	schemas.length === 1 ? (schemas[0] as JsonSchema) : { oneOf: [...schemas] }

/**
 * Add the errors `errorMeta` names to `responses`, one response per status, each status left to an
 * answer the route declares there itself. A key with no status is not documented.
 */
export function addErrorResponses(
	responses: Record<string, ResponseObject>,
	errorMeta: Readonly<Record<string, CollectedError>>,
	settings: ErrorSettings,
	convert: (schema: unknown, hint: string) => JsonSchema,
): void {
	const byStatus = new Map<number, { custom: JsonSchema[]; keys: string[]; standard: string[] }>()
	for (const key of Object.keys(errorMeta).sort(compareCodeUnits)) {
		const { schema, status } = errorMeta[key] as CollectedError
		if (status <= 0 || Object.hasOwn(responses, String(status))) continue
		const group = byStatus.get(status) ?? { custom: [], keys: [], standard: [] }
		byStatus.set(status, group)
		group.keys.push(key)
		if (schema === null) {
			group.standard.push(key)
			continue
		}
		const own = convert(schema, `Error${status}`)
		group.custom.push(settings.customErrorSchema === null ? own : { allOf: [own, settings.customErrorSchema] })
	}
	for (const [code, { custom, keys, standard }] of byStatus) {
		const content: Record<string, MediaObject> = {}
		if (settings.errorFormat === "problem+json") {
			if (standard.length > 0) content["application/problem+json"] = { schema: problem(standard, code) }
			if (custom.length > 0) content["application/json"] = { schema: oneOrOneOf(custom) }
		} else {
			const envelope = standard.length > 0 ? [narrowed(settings.errorSchema ?? defaultEnvelope(), standard, code)] : []
			content["application/json"] = { schema: oneOrOneOf([...envelope, ...custom]) }
		}
		responses[String(code)] = { content, description: keys.join(", ") }
	}
}

/** `responses` keyed in ascending status order: the same bytes however they were declared. */
export function ordered(responses: Record<string, ResponseObject>): Record<string, ResponseObject> {
	return Object.fromEntries(Object.entries(responses).sort(([a], [b]) => Number(a) - Number(b)))
}
