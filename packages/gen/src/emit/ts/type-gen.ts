/**
 * `generateTypes` (F3): an app's `_gen/types.gen.d.ts` — the `Routes` map, each route's ctx,
 * input, output, errors and meta, the route selectors with the `HoneyCodegen` augmentation, and
 * `BaseCtx`. Read from the app's OpenAPI document (the IR), its route tree (meta, O1) and the
 * extracted ctx types (middleware, env, taps, parsed inputs, O3), joined on `x-honey-route`.
 */
import type { ExtractedProp, ExtractedTypes } from "../../extract/extract.ts"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import type { IR, IROperation, IRParam, IRSchema } from "../../ir/model.ts"
import { isJsonMedia, mediaEssence } from "../../ir/sdk-model.ts"
import { bodiesOf } from "../../ir/slots.ts"
import { tsString } from "../shared/escape.ts"
import { compareCodeUnits } from "../shared/lang.ts"
import { literalType, quoteKey } from "../shared/literals.ts"
import { statusKeyOf } from "../shared/status-keys.ts"
import { irToTs, type TypeOptions } from "../shared/type-emitter.ts"
import type { RouteTreeV2 } from "./route-tree.ts"
import { componentNames } from "./sdk-types.ts"

export type GenerateTypesOptions = {
	/** what the ctx base type is named; default `BaseCtx` */
	readonly baseCtxName?: string
	/** the app's OpenAPI document; the IR is built from it with derived operation ids (O5) */
	readonly document: Record<string, unknown>
	/** the app's extracted types; null without ts-morph (inputs then fall back to the document's) */
	readonly extracted: ExtractedTypes | null
	/** what could not be joined, said once each */
	readonly report: (message: string) => void
	/** the app's route tree: each route's meta (O1) */
	readonly tree: RouteTreeV2
}

/* the names the file declares, which a component schema never takes */
const RESERVED = ["HoneyContext", "HoneyError", "Omit", "Readonly", "Record", "Routes", "RouteSelector", "TapMap"]

/* the v1 error-factory signature of a key without a schema (core errors.ts ErrorFactoryOpts) */
const STANDARD_FACTORY =
	"(opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HoneyError"

const EXTRACTORS: readonly (readonly [string, string])[] = [
	["RouteCtx", "ctx"],
	["RouteInput", "input"],
	["RouteOutput", "output"],
	["RouteErrors", "errors"],
	["RouteErrorShapes", "errorShapes"],
	["RouteErrorsByStatus", "errorsByStatus"],
	["RouteMeta", "meta"],
]

type Field = readonly [key: string, type: string]

/** `{ k: T; … }`, or `{}` when there is nothing in it. */
const objectText = (fields: readonly Field[]) =>
	fields.length === 0 ? "{}" : `{ ${fields.map(([key, type]) => `${key}: ${type}`).join("; ")} }`

const propsText = (props: readonly ExtractedProp[]) =>
	objectText(props.map((p) => [`${quoteKey(p.name)}${p.optional ? "?" : ""}`, p.type]))

/** The documented routes by route id; an operation without `x-honey-route` is reported and left out. */
function routesOf(ir: IR, report: (message: string) => void): Map<string, IROperation> {
	const routes = new Map<string, IROperation>()
	const missing: string[] = []
	for (const op of ir.operations) {
		const id = op.extensions.route
		if (op.extensions.websocket === true) continue
		if (id === undefined) missing.push(`${op.method} ${op.path}: no x-honey-route; left out of Routes`)
		/* `all()` and an optional param document one route as several operations: the first speaks for it */
		if (id !== undefined && !routes.has(id)) routes.set(id, op)
	}
	for (const message of missing.sort(compareCodeUnits)) report(message)
	return routes
}

/** A route pattern's params, as core's `ParamKeys` names them: `:name`, `:name?`, `*name`, an unnamed `*`. */
function paramsOf(pattern: string): Field[] {
	const names = [...pattern.matchAll(/:([^/?]+)\??|\*([^/]*)/g)].map((m) => m[1] ?? (m[2] === "" ? "*" : m[2]))
	return [...new Set(names as string[])].map((name) => [quoteKey(name), "string"])
}

type Ctx = { names: TypeOptions; resolve: (schema: IRSchema) => string }

/** The request as the document describes it (the wire type): its query, headers, cookies and body. */
function wireInput(op: IROperation, ctx: Ctx): Field[] {
	const group = (params: readonly IRParam[]) =>
		objectText(
			[...params]
				.sort((a, b) => compareCodeUnits(a.name, b.name))
				.map((p) => [`${quoteKey(p.name)}${p.required === true ? "" : "?"}`, ctx.resolve(p.schema)]),
		)
	const fields: Field[] = []
	if (op.params.query.length > 0) fields.push(["search", group(op.params.query)])
	if (op.params.header.length > 0) fields.push(["headers", group(op.params.header)])
	/* the IR sets `cookie` only when the operation declares one */
	if (op.params.cookie !== undefined) fields.push(["cookies", group(op.params.cookie)])
	const body = bodiesOf(op)[0]
	if (body?.kind === "stream")
		fields.push(["binary", `{ readonly bytes: Uint8Array<ArrayBuffer>; readonly type: ${tsString(body.contentType)} }`])
	else if (body !== undefined) {
		const essence = mediaEssence(body.contentType)
		const field = isJsonMedia(body.contentType) ? "json" : "form"
		if (field === "json" || essence === "application/x-www-form-urlencoded" || essence === "multipart/form-data")
			fields.push([field, ctx.resolve(body.schema)])
	}
	return fields
}

/** What the route answers, error responses aside: `{ [media]: { [statusKey]: T } }`, a redirect as `redirect`. */
function outputOf(op: IROperation, ctx: Ctx): string {
	const media = new Map<string, Field[]>()
	const add = (type: string, field: Field) => media.set(type, [...(media.get(type) ?? []), field])
	for (const response of Object.values(op.responses).sort((a, b) => compareCodeUnits(a.status, b.status))) {
		const key = /^[0-9]{3}$/.test(response.status) ? statusKeyOf(Number(response.status)) : undefined
		if (response.error === true || key === undefined) continue
		const located = response.headers?.some((h) => h.name.toLowerCase() === "location") === true
		if (response.status.startsWith("3") && located && response.contents === undefined) add("redirect", [key, "true"])
		for (const { contentType, schema } of response.contents ?? [])
			add(contentType, [key, schema === undefined ? "unknown" : ctx.resolve(schema)])
	}
	return objectText([...media].map(([type, fields]) => [tsString(type), objectText(fields)]))
}

/** The route's declared errors: their union, each key's shape, and the shapes by status. */
function errorsOf(op: IROperation, ctx: Ctx): { factories: Field[]; fields: Field[] } {
	const declared = op.extensions.errors ?? {}
	const keys = Object.keys(declared).sort(compareCodeUnits)
	if (keys.length === 0) return { factories: [], fields: [["errors", "never"]] }
	const shape = (key: string) => {
		const schema = declared[key]?.schema
		return schema === undefined ? "null" : ctx.resolve(schema)
	}
	const byStatus = new Map<number, Set<string>>()
	for (const key of keys) {
		const status = declared[key]?.status
		if (typeof status === "number") byStatus.set(status, (byStatus.get(status) ?? new Set()).add(shape(key)))
	}
	const statuses = [...byStatus]
		.sort(([a], [b]) => a - b)
		.map(([code, shapes]): Field => [String(code), [...shapes].join(" | ")])
	const factory = (key: string) =>
		shape(key) === "null"
			? STANDARD_FACTORY
			: `(data: ${shape(key)}, opts?: { cause?: unknown; headers?: Record<string, string> }) => HoneyError`
	return {
		factories: keys.map((key) => [quoteKey(key), factory(key)]),
		fields: [
			["errors", keys.map(tsString).join(" | ")],
			["errorShapes", objectText(keys.map((key) => [quoteKey(key), shape(key)]))],
			["errorsByStatus", objectText(statuses)],
		],
	}
}

/** One `Routes[pattern][method]` entry. */
function routeEntry(id: string, op: IROperation, options: GenerateTypesOptions, ctx: Ctx): string {
	const pattern = id.slice(id.indexOf(" ") + 1)
	const { extracted } = options
	const wire = objectText(wireInput(op, ctx))
	const input = extracted?.inputs[id] ?? wire
	const params = paramsOf(pattern)
	const { factories, fields } = errorsOf(op, ctx)
	const mt = options.tree.routes[id]?.mt
	const meta = mt && Object.keys(mt).length > 0 ? literalType(mt) : "{}"
	const output = outputOf(op, ctx)
	const own: Field[] = []
	if (input !== "{}") own.push(["readonly input", input])
	if (params.length > 0) own.push(["readonly params", objectText(params)])
	if (factories.length > 0) own.push(["readonly errors", objectText(factories)])
	own.push(["readonly meta", `Readonly<${meta}>`], ["readonly routePattern", tsString(pattern)])
	const base = options.baseCtxName ?? "BaseCtx"
	const parts = [factories.length > 0 ? `Omit<${base}, "errors">` : base]
	const adds = extracted?.routes[id]
	if (adds !== undefined && adds.length > 0) parts.push(propsText(adds))
	parts.push(objectText(own))
	const entry: Field[] = [
		["ctx", `WithOutput<${parts.join(" & ")}, ${output === "{}" ? "never" : output}>`],
		...fields,
		["input", input],
		["meta", meta],
		["output", output],
	]
	return entry.map(([key, type]) => `\t\t\t${key}: ${type}`).join("\n")
}

/** `BaseCtx`: the app's context over its env, the middleware's additions and its typed taps. */
function baseCtx(extracted: ExtractedTypes | null, name: string): string[] {
	const env = extracted?.env ?? "Record<string, unknown>"
	const taps = extracted?.taps ?? null
	const parts = [taps === null ? `HoneyContext<${env}>` : `Omit<HoneyContext<${env}>, "tap">`]
	const middleware = extracted?.middleware ?? []
	if (middleware.length > 0) parts.push(propsText(middleware))
	if (taps !== null) parts.push("{ tap<K extends keyof TapMap>(key: K, payload: TapMap[K]): void }")
	const lines = taps === null ? [] : [`type TapMap = ${taps}`]
	return [...lines, `export type ${name} = ${parts.join(" & ")}`]
}

/** A route id's path: `GET /a` → `/a`. */
const pathOf = (id: string) => id.slice(id.indexOf(" ") + 1)

/** The `Routes` map: paths and methods in code-unit order. */
function routesType(routes: Map<string, IROperation>, options: GenerateTypesOptions, ctx: Ctx): string {
	const byPath = new Map<string, string[]>()
	const ids = [...routes.keys()].sort(compareCodeUnits)
	for (const id of ids.sort((a, b) => compareCodeUnits(pathOf(a), pathOf(b)) || compareCodeUnits(a, b))) {
		const method = id.slice(0, id.indexOf(" ")).toLowerCase()
		const entry = `\t\t${quoteKey(method)}: {\n${routeEntry(id, routes.get(id) as IROperation, options, ctx)}\n\t\t}`
		byPath.set(pathOf(id), [...(byPath.get(pathOf(id)) ?? []), entry])
	}
	const paths = [...byPath].map(([path, methods]) => `\t${tsString(path)}: {\n${methods.join("\n")}\n\t}`)
	return paths.length === 0 ? "export type Routes = {}" : `export type Routes = {\n${paths.join("\n")}\n}`
}

/** The `types.gen.d.ts` text for the app the options describe. */
export function generateTypes(options: GenerateTypesOptions): string {
	const ir = toIR(options.document as OpenApiDocument, { deriveOperationIds: true })
	const routes = routesOf(ir, options.report)
	const extra = Object.keys(options.extracted?.routes ?? {}).filter((id) => !routes.has(id))
	for (const id of extra.sort(compareCodeUnits))
		options.report(
			`${id}: extracted ctx additions match no documented operation (internal and filtered routes are not documented); not typed`,
		)
	const name = options.baseCtxName ?? "BaseCtx"
	const names: TypeOptions = { refName: componentNames(ir, [...RESERVED, name]) }
	const ctx: Ctx = { names, resolve: (schema) => irToTs(schema, names) }
	const hasErrors = [...routes.values()].some((op) => Object.keys(op.extensions.errors ?? {}).length > 0)
	const selectors = [...routes.keys()].sort(compareCodeUnits)
	const out = [`import type { HoneyContext, WithOutput${hasErrors ? ", HoneyError" : ""} } from "@lovrozagar/honey"`]
	out.push(...baseCtx(options.extracted, name))
	if (selectors.length > 0) {
		out.push(`export type RouteSelector = ${selectors.map(tsString).join(" | ")}`)
		out.push(
			'declare module "@lovrozagar/honey" {\n\tinterface HoneyCodegen {\n\t\trouteSelector: RouteSelector\n\t}\n}',
		)
	}
	for (const schema of Object.keys(ir.schemas).sort(compareCodeUnits))
		out.push(`type ${names.refName?.(schema)} = ${ctx.resolve(ir.schemas[schema] as IRSchema)}`)
	out.push(routesType(routes, options, ctx))
	for (const [type, field] of EXTRACTORS)
		out.push(
			`export type ${type}<TPath extends keyof Routes, TMethod extends keyof Routes[TPath] & string> = Routes[TPath][TMethod] extends { ${field}: infer T } ? T : never`,
		)
	return `${out.join("\n\n")}\n`
}
