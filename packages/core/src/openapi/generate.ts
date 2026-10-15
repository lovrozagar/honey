/**
 * `generateOpenApi(app, options)`: the app's OpenAPI 3.1 document, built synchronously from the
 * routes it serves. Every diagnostic goes through one collector: errors throw one aggregate,
 * warnings go to the logger, nothing to the console. Schemas convert through `jsonSchemaOf` with the
 * caller's converters; a schema that cannot be converted at all fails the document under
 * `onSchemaError: "throw"` (the default) and is documented unconstrained, with a warning, under `"warn"`.
 */
import type { InputEntry } from "../input/input.ts"
import { applyMetaSpec } from "../meta/meta-spec-apply.ts"
import { compileMetaSpec, resolveProfile } from "../meta/meta-spec.ts"
import { metaSpecOf } from "../meta/meta-spec-merge.ts"
import { MetaSpecDiagnostics, schemaMetaLookup, type SchemaMetaLookup } from "../meta/meta-spec-validate.ts"
import { type StatusKey, statusKeyToCode } from "../response/status.ts"
import { GRAPH } from "../routing/app.ts"
import {
	findInvalidSelectors,
	type InvalidateCheckConfig,
	type InvalidateCheckOperation,
	invalidateLevel,
	missingInvalidateReport,
} from "../routing/invalidate-check.ts"
import type { HoneyGraph } from "../routing/register.ts"
import { deduplicateSchemas, type SchemaSpec } from "../schema/slots.ts"
import {
	type ConversionIssue,
	type JsonSchema,
	type JsonSchemaOptions,
	jsonSchemaOf,
} from "../schema/to-json-schema.ts"
import type { Logger } from "../telemetry/logger.ts"
import { type CollectedRoute, type CollectedRoutes, type CollectedWsRoute, collectRoutes } from "./collect.ts"
import { createComponents } from "./components.ts"
import { assembleDocument, type OpenApiDocument, type OpenApiInfo } from "./document.ts"
import { assignOperationIds, buildPaths, type EmittedOperation, type Operation, type PathsContext } from "./paths.ts"
import { addErrorResponses, type Convert, type ErrorSettings, ordered, successResponses } from "./responses.ts"
import { checkSecurity } from "./security.ts"
import { type OpenApiServer, serversOf } from "./servers.ts"
import { type OpenApiExternalDocs, type OpenApiTag, tagsOf } from "./tags.ts"
import { type OpenApiWebhook, webhooksOf } from "./webhooks.ts"

export type { OpenApiDocument, OpenApiInfo } from "./document.ts"
export type { OpenApiServer, OpenApiServerVariable } from "./servers.ts"
export type { OpenApiExternalDocs, OpenApiTag } from "./tags.ts"
export type { OpenApiWebhook, WebhookSignature } from "./webhooks.ts"

/** What `filterRoutes` is shown of a route: its resolved meta, its method and its honey pattern. */
export type OpenApiRouteInfo = {
	readonly meta: Readonly<Record<string, unknown>>
	readonly method: string
	readonly path: string
}

export type GenerateOpenApiOptions = {
	readonly converters?: JsonSchemaOptions["converters"]
	/** the document's own external docs */
	readonly externalDocs?: OpenApiExternalDocs
	/** leave out every route this answers false for */
	readonly filterRoutes?: (route: OpenApiRouteInfo) => boolean
	readonly info: OpenApiInfo
	/** mutations that declare no `invalidate`: reported at `"warn"` (the default), failing at `"error"` */
	readonly invalidate?: InvalidateCheckConfig
	/** where warnings go; the app's logger by default */
	readonly logger?: Logger
	/** a schema no converter can describe: fail the document (`"throw"`, the default) or document it `{}` */
	readonly onSchemaError?: "throw" | "warn"
	/** the metaSpec profile this document carries */
	readonly profile?: string
	readonly securitySchemes?: Readonly<Record<string, unknown>>
	/** the servers it lists, in place of the stripped prefix; that prefix is appended to each */
	readonly servers?: readonly OpenApiServer[]
	/** metadata for the tags operations name; tags are never derived */
	readonly tags?: readonly OpenApiTag[]
	/** the requests the API sends subscribers, by name */
	readonly webhooks?: Readonly<Record<string, OpenApiWebhook>>
}

type App = { readonly [GRAPH]: HoneyGraph }

/** What a conversion issue reports, and how loudly. */
function issueOf(
	issue: ConversionIssue,
	onError: "throw" | "warn",
): [code: "SCHEMA_DEGRADED" | "SCHEMA_FAILED", level: "error" | "warn", text: string] {
	if (issue.kind === "failed") {
		const reason = issue.error instanceof Error ? issue.error.message : String(issue.error)
		return [
			"SCHEMA_FAILED",
			onError === "throw" ? "error" : "warn",
			`a ${issue.vendor} schema (${issue.io}) could not be converted: ${reason}`,
		]
	}
	if (issue.kind === "degraded")
		return [
			"SCHEMA_DEGRADED",
			"warn",
			`a ${issue.vendor} schema (${issue.io}) documents ${issue.nodes.join(", ")} unconstrained`,
		]
	return [
		"SCHEMA_DEGRADED",
		"warn",
		`no JSON Schema converter for vendor "${issue.vendor}" (${issue.io}); documented unconstrained`,
	]
}

/** The schemas a route's metaSpec schema entries read: its lowest 2xx JSON answer and each input source. */
function rootsOf(route: CollectedRoute | CollectedWsRoute, options: JsonSchemaOptions): SchemaMetaLookup {
	const roots: Record<string, JsonSchema> = {}
	const json = "output" in route ? route.output?.["application/json"] : undefined
	const codes = Object.keys(json ?? {})
		.map((key) => [statusKeyToCode[key as StatusKey], key] as const)
		.filter(([code]) => code >= 200 && code < 300)
		.sort(([a], [b]) => a - b)
	const primary = codes[0] === undefined ? undefined : json?.[codes[0][1] as StatusKey]
	if (primary !== undefined && primary !== true) roots.output = jsonSchemaOf(primary, "output", options)
	for (const [source, entry] of Object.entries(route.input ?? {})) {
		if (source === "binary") continue
		const schema = "_tag" in (entry as InputEntry) ? (entry as { schema: unknown }).schema : entry
		roots[`input.${source}`] = jsonSchemaOf(schema, "input", options)
	}
	return schemaMetaLookup(roots)
}

/** One document's state: what every step reads and reports into. */
type Run = {
	readonly components: ReturnType<typeof createComponents>
	readonly diagnostics: MetaSpecDiagnostics
	readonly options: GenerateOpenApiOptions
	readonly profile: { readonly filter: (key: string) => boolean; readonly name: string }
	readonly spec: ReturnType<typeof compileMetaSpec>
}

/** The converter for one route: `jsonSchemaOf`, its local references lifted, its issues reported against `where`. */
function converterOf(run: Run): (where: string) => Convert {
	const onSchemaError = run.options.onSchemaError ?? "throw"
	return (where) => (schema, io, hint) => {
		const report = (issue: ConversionIssue) => {
			const [code, level, text] = issueOf(issue, onSchemaError)
			run.diagnostics.add(code, level, `${where}: ${text}`)
		}
		return run.components.hoist(jsonSchemaOf(schema, io, { converters: run.options.converters, report }), hint)
	}
}

/** The routes the document describes: none internal, none `filterRoutes` rejects. */
function routesOf(app: App, options: GenerateOpenApiOptions): CollectedRoutes {
	const keep = (route: CollectedRoute | CollectedWsRoute, method: string) =>
		route.meta.internal !== true && (options.filterRoutes?.({ meta: route.meta, method, path: route.pattern }) ?? true)
	const collected = collectRoutes(app)
	return {
		http: collected.http.filter((route) => keep(route, route.method)),
		ws: collected.ws.filter((route) => keep(route, "WS")),
	}
}

/** The policy's fields for one operation of `route`. */
function policyOf(run: Run): PathsContext["policy"] {
	const { diagnostics, profile, spec } = run
	return (route, method, kind) => {
		const operation: Operation = {}
		const schemaMeta = spec.needsSchemas ? rootsOf(route, { converters: run.options.converters }) : undefined
		const meta = route.meta
		const { filter, name } = profile
		applyMetaSpec({
			diagnostics,
			filter,
			kind,
			meta,
			method,
			operation,
			path: route.pattern,
			profile: name,
			schemaMeta,
			spec,
		})
		return operation
	}
}

/** A route's responses: what it declares, its errors, else a bare 200. */
function responsesOf(errors: ErrorSettings): PathsContext["responses"] {
	return (route, convert, hint) => {
		const out = successResponses(route.output, convert, hint)
		addErrorResponses(out, route.errorMeta, errors, (schema, h) => convert(schema, "output", h))
		return Object.keys(out).length === 0 ? { "200": { description: "Success" } } : ordered(out)
	}
}

/** The checks over the whole document: ids, security, invalidate selectors, then every diagnostic out. */
function check(run: Run, operations: readonly EmittedOperation[], routes: CollectedRoutes, logger: Logger): void {
	const { diagnostics, options } = run
	assignOperationIds(operations, (message) => diagnostics.add("DUPLICATE_OPERATION_ID", "error", message))
	checkSecurity(operations, options.securitySchemes, (level, message) =>
		diagnostics.add("UNKNOWN_SECURITY_SCHEME", level, message),
	)
	const emitted: InvalidateCheckOperation[] = operations
		.filter(({ route }) => "registration" in route)
		.map(({ method, operation, path, route }) => ({ meta: route.meta, method, operation, path }))
	const level = invalidateLevel(options.invalidate)
	if (level !== "off") {
		const inventory = new Set(routes.http.map((route) => route.id))
		for (const bad of findInvalidSelectors(emitted, inventory)) {
			const selector = JSON.stringify(bad.selector)
			const hint = 'write "<METHOD> <pattern>" for a registered route, e.g. "GET /users/:id"'
			diagnostics.add(
				"INVALID_SELECTOR",
				"error",
				`${bad.method} ${bad.path}: invalidate selector ${selector} names no route — ${hint}`,
			)
		}
	}
	for (const { code, message } of diagnostics.throwIfErrors()) logger.warn(`[honey:openapi] ${code}: ${message}`)
	const missing = missingInvalidateReport(emitted, options.invalidate)
	if (missing !== null && level === "error") throw new Error(missing)
	if (missing !== null) logger.warn(missing)
}

/** The app's OpenAPI 3.1 document. */
export function generateOpenApi(app: App, options: GenerateOpenApiOptions): OpenApiDocument {
	const settings = app[GRAPH].settings
	const diagnostics = new MetaSpecDiagnostics()
	const spec = compileMetaSpec(metaSpecOf(app), diagnostics)
	const run: Run = {
		components: createComponents(),
		diagnostics,
		options,
		profile: resolveProfile(spec, options.profile, diagnostics),
		spec,
	}
	const convertFor = converterOf(run)
	const settingsSchema = (schema: unknown, hint: string) =>
		schema === null ? null : convertFor("the app's error schema")(schema, "output", hint)
	const errors: ErrorSettings = {
		customErrorSchema: settingsSchema(settings.customErrorSchema, "CustomError"),
		errorFormat: settings.errorFormat,
		errorSchema: settingsSchema(settings.errorSchema, "Error"),
	}
	const routes = routesOf(app, options)
	const { operations, paths } = buildPaths(routes, {
		convert: convertFor,
		policy: policyOf(run),
		responses: responsesOf(errors),
		trailingSlash: settings.trailingSlash,
		warn: (code, message) => diagnostics.add(code, "warn", message),
	})
	const report = (code: "INVALID_SERVER" | "INVALID_WEBHOOK") => (message: string) =>
		diagnostics.add(code, "error", message)
	const servers = serversOf(options.servers, settings.stripPrefix, report("INVALID_SERVER"))
	const webhooks = webhooksOf(options.webhooks, convertFor("webhooks"), report("INVALID_WEBHOOK"))
	const tags = tagsOf(operations, options.tags, (code, level, message) => diagnostics.add(code, level, message))
	check(run, operations, routes, options.logger ?? settings.logger)
	const document = assembleDocument({
		externalDocs: options.externalDocs,
		info: options.info,
		paths,
		schemas: run.components.schemas(),
		securitySchemes: options.securitySchemes,
		servers,
		tags,
		webhooks,
	})
	return deduplicateSchemas(document as unknown as SchemaSpec) as unknown as OpenApiDocument
}
