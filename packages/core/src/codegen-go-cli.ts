/* Go CLI emitter — generates a complete cobra-based Go CLI module from an OpenAPI 3.1 spec.
 *
 * Mirrors the pattern used by codegen-go.ts:
 *   - Static runtime files (config.go, auth.go, output.go, errors.go, stream.go, multipart.go,
 *     version.go, root.go) are read from ./cli-go/ at module load time and copied verbatim
 *     into the output file map under "cli-go/<name>".
 *   - Per-resource cobra command files are emitted as cmd/<resource>.go.
 *   - main.go and cmd/root.go wire cobra + auth + exit-code mapping.
 *
 * Two SDK wiring modes:
 *   - sdkModulePath set → go.mod emits `require` + `replace`; no internal/sdk/ files.
 *   - sdkModulePath omitted → client-go/* + generated types.go + client.go embedded under
 *     internal/sdk/; emitted imports use "<modulePath>/internal/sdk".
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { generateGoSDK, safeResourceName } from "./codegen-go.ts"
import { collectSDKMethods, extractOpenApiPathParams, isSSEOperation, resolveRefs } from "./codegen.ts"
import { toIR } from "./codegen-ir.ts"
import { goPascal } from "./go-type-emitter.ts"

const DEFAULT_MODULE_PATH = "example.com/cli"

function resolveModulePath(options: GoCLIOptions): string {
	return options.modulePath ?? DEFAULT_MODULE_PATH
}

function enumStrings(schema: Record<string, unknown>): string[] {
	return Array.isArray(schema.enum) ? (schema.enum as unknown[]).map((v) => String(v)) : []
}

function isLastEventIdName(name: string): boolean {
	return name === "last-event-id" || name === "last_event_id" || name === "lastEventId"
}

/* ── types ── */

export type GoCLIOptions = {
	binaryName: string
	modulePath?: string
	sdkModulePath?: string
	envPrefix?: string
	configName?: string
	defaultBaseURL?: string
	description?: string
}

export type GeneratedGoCLI = {
	files: Record<string, string>
	serviceMap: Record<string, Record<string, unknown>>
	skippedOperations: string[]
}

type OpenApiSpec = {
	components?: { schemas?: Record<string, Record<string, unknown>> }
	info: { description?: string; title: string; version: string }
	openapi: string
	paths: Record<string, Record<string, Record<string, unknown>>>
}

type ParamInfo = {
	name: string
	flagName: string
	varName: string
	required: boolean
	schema: Record<string, unknown>
	defaultValue: unknown
	enumValues: string[]
}

type BodyScalarInfo = {
	propName: string
	flagName: string
	varName: string
	schemaType: string
	enumValues: string[]
}

type BodyShape =
	| { kind: "none" }
	| { kind: "json-flat"; scalars: BodyScalarInfo[]; required: boolean }
	| { kind: "json-complex"; required: boolean }
	| {
		kind: "multipart"
		binaryFields: { name: string; required: boolean }[]
		scalarFields: BodyScalarInfo[]
		useGenericFileFlag: boolean
	}

type CommandInfo = {
	opId: string
	resource: string
	action: string /* joined-with-dash deeper-than-2 dot segments */
	cmdVarName: string /* e.g. "usersGetCmd" */
	cmdUse: string /* e.g. "get" */
	method: string /* GET, POST, ... */
	path: string
	summary: string
	description: string
	pathParams: ParamInfo[]
	queryParams: ParamInfo[]
	body: BodyShape
	isSSE: boolean
	hasLastEventId: boolean
	has204: boolean
	responseType: "json" | "none"
}

type ResourceGroup = {
	resource: string /* raw resource e.g. "apiKey" */
	cmdUse: string /* kebab e.g. "api-key" */
	cmdVarBase: string /* Go var prefix e.g. "apiKey" or "type_" */
	fileName: string /* e.g. "apiKey.go" (matches raw resource) */
	commands: CommandInfo[]
}

/* ── case transforms ── */

/** Converts camelCase / snake_case / acronyms to kebab-case (e.g. "APIKey" → "api-key"). */
export function toKebab(s: string): string {
	if (!s) return s
	return s
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-")
		.toLowerCase()
}

export function toFlagName(paramName: string): string {
	return toKebab(paramName)
}

/** Upper snake case for env var: toSnakeUpper("project-id") → "PROJECT_ID". */
function toSnakeUpper(s: string): string {
	return toKebab(s).toUpperCase().replace(/-/g, "_")
}

export function envVarFromFlag(flagName: string, envPrefix: string): string {
	return `${envPrefix}_${toSnakeUpper(flagName)}`
}

/** Go var name from a param name: snake_case or kebab-case → camelCase with preserved acronyms.
 *  e.g. "project_id" → "projectID", "user-name" → "userName", "type" → "type_". */
function goCamelVar(name: string): string {
	const pascal = goPascal(name)
	if (!pascal) return pascal
	/* preserve acronym tail: "Id" → "ID", "Url" → "URL" */
	const fixed = pascal
		.replace(/\bId\b/g, "ID")
		.replace(/\bUrl\b/g, "URL")
		.replace(/Id$/, "ID")
		.replace(/Url$/, "URL")
	const camel = fixed.charAt(0).toLowerCase() + fixed.slice(1)
	return safeResourceName(camel)
}

/* ── runtime template loader ── */

let runtimeCache: Map<string, string> | null = null

/** Reads static .go runtime files from ./cli-go/ and caches them. */
export function loadGoCliRuntimeTemplates(): Map<string, string> {
	if (runtimeCache) return runtimeCache
	const names = [
		"config.go",
		"auth.go",
		"output.go",
		"errors.go",
		"stream.go",
		"multipart.go",
		"version.go",
		"root.go",
	]
	const cache = new Map<string, string>()
	for (const name of names) {
		const filePath = fileURLToPath(new URL(`./cli-go/${name}`, import.meta.url))
		let content: string
		try {
			content = readFileSync(filePath, "utf8")
		} catch {
			throw new Error(`loadGoCliRuntimeTemplates: missing file ${filePath}`)
		}
		cache.set(name, content)
	}
	runtimeCache = cache
	return cache
}

/* ── param + body helpers ── */

function getPathParams(
	op: Record<string, unknown>,
	rawPath: string,
): ParamInfo[] {
	const declared = extractOpenApiPathParams(rawPath)
	const byName = new Map<string, Record<string, unknown>>()
	const parameters = (op.parameters as Array<Record<string, unknown>> | undefined) ?? []
	for (const p of parameters) {
		if (p.in !== "path") continue
		byName.set(String(p.name), p)
	}

	const out: ParamInfo[] = []
	for (const name of declared) {
		const param = byName.get(name)
		const schema = (param?.schema as Record<string, unknown>) ?? { type: "string" }
		out.push({
			defaultValue: schema.default,
			enumValues: enumStrings(schema),
			flagName: toFlagName(name),
			name,
			required: true,
			schema,
			varName: goCamelVar(name),
		})
	}
	return out
}

function getQueryParams(op: Record<string, unknown>): ParamInfo[] {
	const parameters = (op.parameters as Array<Record<string, unknown>> | undefined) ?? []
	const out: ParamInfo[] = []
	for (const p of parameters) {
		if (p.in !== "query") continue
		const name = String(p.name)
		const schema = (p.schema as Record<string, unknown>) ?? { type: "string" }
		out.push({
			defaultValue: schema.default,
			enumValues: enumStrings(schema),
			flagName: toFlagName(name),
			name,
			required: p.required === true,
			schema,
			varName: goCamelVar(name),
		})
	}
	return out
}

function isScalarType(t: unknown): t is "string" | "integer" | "number" | "boolean" {
	return t === "string" || t === "integer" || t === "number" || t === "boolean"
}

function detectBodyShape(op: Record<string, unknown>): BodyShape {
	const requestBody = op.requestBody as Record<string, unknown> | undefined
	if (!requestBody) return { kind: "none" }
	const required = requestBody.required === true
	const content = requestBody.content as Record<string, Record<string, unknown>> | undefined
	if (!content) return { kind: "none" }

	/* multipart wins over json */
	const multipart = content["multipart/form-data"]
	if (multipart) {
		const schema = (multipart.schema as Record<string, unknown>) ?? {}
		const props = (schema.properties as Record<string, Record<string, unknown>>) ?? {}
		const reqList = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
		const binaryFields: { name: string; required: boolean }[] = []
		const scalarFields: BodyScalarInfo[] = []
		for (const [propName, propSchema] of Object.entries(props)) {
			const type = propSchema.type
			const format = propSchema.format
			if (type === "string" && format === "binary") {
				binaryFields.push({ name: propName, required: reqList.has(propName) })
			} else if (isScalarType(type)) {
				scalarFields.push({
					enumValues: enumStrings(propSchema),
					flagName: toFlagName(propName),
					propName,
					schemaType: String(type),
					varName: goCamelVar(propName),
				})
			}
		}
		return {
			binaryFields,
			kind: "multipart",
			scalarFields,
			useGenericFileFlag: binaryFields.length === 1,
		}
	}

	const jsonContent = content["application/json"]
	if (!jsonContent) return { kind: "none" }
	const schema = (jsonContent.schema as Record<string, unknown>) ?? {}

	/* oneOf/anyOf/allOf, array-root, or non-object → complex */
	if (schema.oneOf || schema.anyOf || schema.allOf) {
		return { kind: "json-complex", required }
	}
	if (schema.type !== "object") {
		return { kind: "json-complex", required }
	}

	const props = (schema.properties as Record<string, Record<string, unknown>>) ?? {}
	const scalars: BodyScalarInfo[] = []
	let allScalar = true
	for (const [propName, propSchema] of Object.entries(props)) {
		if (!isScalarType(propSchema.type)) {
			allScalar = false
			break
		}
		scalars.push({
			enumValues: enumStrings(propSchema),
			flagName: toFlagName(propName),
			propName,
			schemaType: String(propSchema.type),
			varName: goCamelVar(propName),
		})
	}
	if (!allScalar) return { kind: "json-complex", required }
	return { kind: "json-flat", required, scalars }
}

function has204Response(op: Record<string, unknown>): boolean {
	const responses = op.responses as Record<string, Record<string, unknown>> | undefined
	if (!responses) return false
	return Object.prototype.hasOwnProperty.call(responses, "204")
}

function hasJsonResponse(op: Record<string, unknown>): boolean {
	const responses = op.responses as Record<string, Record<string, unknown>> | undefined
	if (!responses) return false
	for (const [code, resp] of Object.entries(responses)) {
		const n = Number.parseInt(code, 10)
		if (n < 200 || n >= 300 || n === 204) continue
		const content = resp.content as Record<string, Record<string, unknown>> | undefined
		if (content?.["application/json"]) return true
	}
	return false
}

/* ── command collection ── */

function collectCLIMethods(
	spec: Record<string, unknown>,
): { groups: Map<string, ResourceGroup>; skipped: string[]; serviceMap: Record<string, Record<string, unknown>> } {
	toIR(spec as Parameters<typeof toIR>[0])
	const { serviceMap } = collectSDKMethods(spec as Parameters<typeof collectSDKMethods>[0])
	const resolved = resolveRefs(spec as Parameters<typeof resolveRefs>[0]) as unknown as OpenApiSpec

	const groups = new Map<string, ResourceGroup>()
	const skipped: string[] = []
	const seenCmdPaths = new Map<string, string>()

	for (const [rawPath, pathMethods] of Object.entries(resolved.paths ?? {})) {
		for (const [method, operation] of Object.entries(pathMethods)) {
			const op = operation as Record<string, unknown>
			const operationId = op.operationId as string | undefined
			if (!operationId) continue

			if (op["x-websocket"] === true) {
				skipped.push(operationId)
				continue
			}

			const segments = operationId.split(".")
			const resource = segments[0]
			/* Top-level ops (single segment) are conventionally marked `_call` in the
			 * SDK IR. For the CLI tree we use "call" so the emitted subcommand is
			 * `<resource> call` — cobra rejects leading dashes. */
			const actionSegments = segments.length === 1 ? ["call"] : segments.slice(1).map((seg) => toKebab(seg))
			const action = actionSegments.join("-")
			const cmdUse = action

			/* collision check: (resource, cmdUse) must be unique */
			const key = `${resource}|${cmdUse}`
			if (seenCmdPaths.has(key)) {
				throw new Error(
					`go-cli codegen: command path collision for ${resource} ${cmdUse} — operations: ${seenCmdPaths.get(key)}, ${operationId}`,
				)
			}
			seenCmdPaths.set(key, operationId)

			let group = groups.get(resource)
			if (!group) {
				group = {
					cmdUse: toKebab(resource),
					cmdVarBase: safeResourceName(resource.charAt(0).toLowerCase() + resource.slice(1)),
					commands: [],
					fileName: `${resource}.go`,
					resource,
				}
				groups.set(resource, group)
			}

			const pathParams = getPathParams(op, rawPath)
			const queryParams = getQueryParams(op)
			const body = detectBodyShape(op)
			const sse = isSSEOperation(op)
			const hasLastEventId = queryParams.some((q) => isLastEventIdName(q.name))

			/* body rename: if a body scalar conflicts with a path param, rename flag to "body-<name>" */
			if (body.kind === "json-flat") {
				const pathNames = new Set(pathParams.map((p) => p.flagName))
				body.scalars = body.scalars.map((s) => {
					if (pathNames.has(s.flagName)) {
						return { ...s, flagName: `body-${s.flagName}`, varName: `body${goPascal(s.propName)}` }
					}
					return s
				})
			}

			/* query rename: cobra reserves --help, --version */
			for (const q of queryParams) {
				if (q.flagName === "help" || q.flagName === "version") {
					q.flagName = `query-${q.flagName}`
				}
			}

			const actionPascal = goPascal(action)
			const cmdVarName = `${group.cmdVarBase}${actionPascal}Cmd`
			const has204 = has204Response(op)
			const hasJson = hasJsonResponse(op)
			let responseType: "json" | "none" = "none"
			if (!sse && hasJson) responseType = "json"

			group.commands.push({
				action,
				body,
				cmdUse,
				cmdVarName,
				description: String(op.description ?? ""),
				has204,
				hasLastEventId,
				isSSE: sse,
				method: method.toUpperCase(),
				opId: operationId,
				path: rawPath,
				pathParams,
				queryParams,
				resource,
				responseType,
				summary: String(op.summary ?? ""),
			})
		}
	}

	return { groups, serviceMap: serviceMap as Record<string, Record<string, unknown>>, skipped }
}

/* ── emit: cmd/root.go ── */

function emitRootFile(groups: ResourceGroup[], options: GoCLIOptions): string {
	const envPrefix = options.envPrefix ?? toSnakeUpper(options.binaryName)
	const configName = options.configName ?? options.binaryName
	const defaultBase = options.defaultBaseURL ?? ""

	const l: string[] = []
	l.push(`// Code generated by honey. DO NOT EDIT.`)
	l.push(`package cmd`)
	l.push(``)
	l.push(`import (`)
	l.push(`\t"context"`)
	l.push(`\t"fmt"`)
	l.push(`\t"os"`)
	l.push(``)
	l.push(`\t"github.com/spf13/cobra"`)
	l.push(``)
	l.push(`\tcli "${cliImportPath(options)}"`)
	l.push(`)`)
	l.push(``)
	l.push(`var _ = fmt.Sprintf`)
	l.push(`var _ = os.Exit`)
	l.push(``)
	l.push(`// EnvPrefix is the prefix used for all <PREFIX>_<FLAG> environment variables.`)
	l.push(`const EnvPrefix = ${JSON.stringify(envPrefix)}`)
	l.push(``)
	l.push(`// ConfigName is the directory name under $XDG_CONFIG_HOME / ~/.config for the config file.`)
	l.push(`const ConfigName = ${JSON.stringify(configName)}`)
	l.push(``)
	l.push(`// DefaultBaseURL is used when neither --base-url, env var, nor the config file provide one.`)
	l.push(`const DefaultBaseURL = ${JSON.stringify(defaultBase)}`)
	l.push(``)
	l.push(`type configKey struct{}`)
	l.push(``)
	l.push(`// runtimeConfig is the resolved CLI config stashed on the cobra context.`)
	l.push(`type runtimeConfig struct {`)
	l.push(`\tCfg cli.Config`)
	l.push(`}`)
	l.push(``)
	l.push(`// rootCmd is the top-level cobra command for the ${options.binaryName} CLI.`)
	l.push(`var rootCmd = &cobra.Command{`)
	l.push(`\tUse:     ${JSON.stringify(options.binaryName)},`)
	l.push(`\tShort:   ${JSON.stringify(options.description ?? `${options.binaryName} CLI`)},`)
	l.push(`\tVersion: cli.Version,`)
	l.push(`\tSilenceUsage: true,`)
	l.push(`\tPersistentPreRunE: func(cmd *cobra.Command, args []string) error {`)
	l.push(`\t\tcfg, err := cli.LoadConfig(cmd.Flags(), EnvPrefix, ConfigName)`)
	l.push(`\t\tif err != nil {`)
	l.push(`\t\t\treturn err`)
	l.push(`\t\t}`)
	l.push(`\t\tif cfg.BaseURL == "" {`)
	l.push(`\t\t\tcfg.BaseURL = DefaultBaseURL`)
	l.push(`\t\t}`)
	l.push(`\t\tctx := context.WithValue(cmd.Context(), configKey{}, runtimeConfig{Cfg: cfg})`)
	l.push(`\t\tcmd.SetContext(ctx)`)
	l.push(`\t\treturn nil`)
	l.push(`\t},`)
	l.push(`}`)
	l.push(``)
	l.push(`// Execute runs the root command.`)
	l.push(`func Execute() error {`)
	l.push(`\treturn rootCmd.Execute()`)
	l.push(`}`)
	l.push(``)
	l.push(`func configFromCtx(ctx context.Context) cli.Config {`)
	l.push(`\tif v, ok := ctx.Value(configKey{}).(runtimeConfig); ok {`)
	l.push(`\t\treturn v.Cfg`)
	l.push(`\t}`)
	l.push(`\treturn cli.Config{}`)
	l.push(`}`)
	l.push(``)
	l.push(`func init() {`)
	l.push(`\trootCmd.PersistentFlags().String("api-key", "", "API key (overrides env + config file)")`)
	l.push(`\trootCmd.PersistentFlags().String("base-url", "", "Override API base URL")`)
	l.push(`\trootCmd.PersistentFlags().String("output", "json", "Output mode: json|ndjson|yaml|table")`)
	l.push(`\trootCmd.PersistentFlags().Bool("verbose", false, "Print request metadata to stderr")`)
	l.push(`\trootCmd.PersistentFlags().String("config", "", "Path to config file")`)
	l.push(`\trootCmd.PersistentFlags().String("timeout", "30s", "Request timeout (Go duration)")`)
	for (const g of groups) {
		const cmdVar = `${g.cmdVarBase}Cmd`
		l.push(`\trootCmd.AddCommand(${cmdVar})`)
	}
	l.push(`}`)
	l.push(``)
	return l.join("\n")
}

function cliImportPath(options: GoCLIOptions): string {
	return `${resolveModulePath(options)}/internal/cli`
}

function sdkImportPath(options: GoCLIOptions): string {
	if (options.sdkModulePath) return options.sdkModulePath
	return `${resolveModulePath(options)}/internal/sdk`
}

/* ── emit: cmd/<resource>.go ── */

function emitResourceFile(group: ResourceGroup, options: GoCLIOptions): string {
	const l: string[] = []
	const hasSSE = group.commands.some((c) => c.isSSE)
	l.push(`// Code generated by honey. DO NOT EDIT.`)
	l.push(`package cmd`)
	l.push(``)
	l.push(`import (`)
	l.push(`\t"bytes"`)
	l.push(`\t"context"`)
	l.push(`\t"encoding/json"`)
	l.push(`\t"fmt"`)
	l.push(`\t"io"`)
	if (hasSSE) l.push(`\t"iter"`)
	l.push(`\t"net/http"`)
	l.push(`\t"net/url"`)
	l.push(`\t"os"`)
	l.push(`\t"slices"`)
	l.push(`\t"strings"`)
	l.push(`\t"time"`)
	l.push(``)
	l.push(`\t"github.com/spf13/cobra"`)
	l.push(``)
	l.push(`\tcli "${cliImportPath(options)}"`)
	l.push(`\tsdk "${sdkImportPath(options)}"`)
	l.push(`)`)
	l.push(``)
	l.push(`var _ = bytes.NewReader`)
	l.push(`var _ = context.TODO`)
	l.push(`var _ = json.Marshal`)
	l.push(`var _ = fmt.Sprintf`)
	l.push(`var _ = io.Discard`)
	l.push(`var _ = http.MethodGet`)
	l.push(`var _ = url.PathEscape`)
	l.push(`var _ = os.Stdout`)
	l.push(`var _ = slices.Contains[[]string]`)
	l.push(`var _ = strings.NewReader`)
	l.push(`var _ = time.Second`)
	l.push(`var _ = sdk.SSEEvent{}`)
	l.push(`var _ = cli.Version`)
	if (hasSSE) l.push(`var _ iter.Seq2[cli.SSEEvent, error]`)
	l.push(``)

	/* resource-level var */
	const resShort = group.commands[0]?.summary ?? `${group.cmdUse} commands`
	l.push(`var ${group.cmdVarBase}Cmd = &cobra.Command{`)
	l.push(`\tUse:   ${JSON.stringify(group.cmdUse)},`)
	l.push(`\tShort: ${JSON.stringify(resShort)},`)
	l.push(`}`)
	l.push(``)

	/* per-command vars */
	for (const cmd of group.commands) {
		emitCommand(l, group, cmd, options)
	}

	/* init() wires subcommands + registers their flags */
	l.push(`func init() {`)
	for (const cmd of group.commands) {
		l.push(`\t${group.cmdVarBase}Cmd.AddCommand(${cmd.cmdVarName})`)
	}
	for (const cmd of group.commands) {
		emitFlagRegistrations(l, cmd)
	}
	l.push(`}`)
	l.push(``)

	return l.join("\n")
}

/** Emits var declarations for every flag-backing Go variable + the cobra.Command literal. */
function emitCommand(
	l: string[],
	group: ResourceGroup,
	cmd: CommandInfo,
	options: GoCLIOptions,
): void {
	/* flag-backing vars */
	for (const p of cmd.pathParams) {
		l.push(`var ${cmd.cmdVarName}${goPascal(p.name)}Var string`)
	}
	for (const q of cmd.queryParams) {
		l.push(`var ${cmd.cmdVarName}${goPascal(q.name)}Var ${goFlagVarType(q)}`)
	}
	if (cmd.body.kind === "json-flat" || cmd.body.kind === "json-complex") {
		l.push(`var ${cmd.cmdVarName}DataVar string`)
	}
	if (cmd.body.kind === "json-flat") {
		for (const s of cmd.body.scalars) {
			l.push(`var ${cmd.cmdVarName}${goPascal(s.propName)}Var ${goScalarVarType(s.schemaType)}`)
		}
	}
	if (cmd.body.kind === "multipart") {
		for (const s of cmd.body.scalarFields) {
			l.push(`var ${cmd.cmdVarName}${goPascal(s.propName)}Var ${goScalarVarType(s.schemaType)}`)
		}
		if (cmd.body.useGenericFileFlag) {
			l.push(`var ${cmd.cmdVarName}FileVar string`)
		} else {
			for (const f of cmd.body.binaryFields) {
				l.push(`var ${cmd.cmdVarName}${goPascal(f.name)}Var string`)
			}
		}
	}
	if (cmd.hasLastEventId) {
		l.push(`var ${cmd.cmdVarName}LastEventIDVar string`)
	}
	l.push(``)

	const shortDesc = cmd.summary || cmd.action
	l.push(`var ${cmd.cmdVarName} = &cobra.Command{`)
	l.push(`\tUse:   ${JSON.stringify(cmd.cmdUse)},`)
	l.push(`\tShort: ${JSON.stringify(shortDesc)},`)

	/* PreRunE: validate required body + enums */
	const preRunELines = emitPreRunE(cmd)
	if (preRunELines.length > 0) {
		l.push(`\tPreRunE: func(cmd *cobra.Command, args []string) error {`)
		for (const line of preRunELines) l.push(`\t\t${line}`)
		l.push(`\t\treturn nil`)
		l.push(`\t},`)
	}

	l.push(`\tRunE: func(cmd *cobra.Command, args []string) error {`)
	emitRunE(l, cmd, options)
	l.push(`\t},`)
	l.push(`}`)
	l.push(``)
}

function goFlagVarType(q: ParamInfo): string {
	const t = q.schema.type
	if (t === "integer") return "int64"
	if (t === "number") return "float64"
	if (t === "boolean") return "bool"
	if (t === "array") return "[]string"
	return "string"
}

function goScalarVarType(t: string): string {
	if (t === "integer") return "int64"
	if (t === "number") return "float64"
	if (t === "boolean") return "bool"
	return "string"
}

function emitFlagRegistrations(l: string[], cmd: CommandInfo): void {
	for (const p of cmd.pathParams) {
		const v = `${cmd.cmdVarName}${goPascal(p.name)}Var`
		/* flag docstring references original param name for discoverability */
		l.push(`\t/* Path flag — Use: ${JSON.stringify(p.name)} */`)
		l.push(`\t${cmd.cmdVarName}.Flags().StringVar(&${v}, ${JSON.stringify(p.flagName)}, "", ${JSON.stringify(`Path parameter ${p.name}`)})`)
		l.push(`\t${cmd.cmdVarName}.MarkFlagRequired(${JSON.stringify(p.flagName)})`)
	}
	for (const q of cmd.queryParams) {
		if (isLastEventIdName(q.name)) continue
		emitQueryFlag(l, cmd, q)
	}
	if (cmd.body.kind === "json-flat" || cmd.body.kind === "json-complex") {
		l.push(`\t${cmd.cmdVarName}.Flags().StringVar(&${cmd.cmdVarName}DataVar, "data", "", "Request body: JSON literal, @file, or - for stdin")`)
	}
	if (cmd.body.kind === "json-flat") {
		for (const s of cmd.body.scalars) {
			emitBodyScalarFlag(l, cmd, s)
		}
	}
	if (cmd.body.kind === "multipart") {
		for (const s of cmd.body.scalarFields) {
			emitBodyScalarFlag(l, cmd, s)
		}
		if (cmd.body.useGenericFileFlag) {
			l.push(`\t${cmd.cmdVarName}.Flags().StringVar(&${cmd.cmdVarName}FileVar, "file", "", "Path to file to upload")`)
			const bin = cmd.body.binaryFields[0]
			if (bin?.required) {
				l.push(`\t${cmd.cmdVarName}.MarkFlagRequired("file")`)
			}
		} else {
			for (const f of cmd.body.binaryFields) {
				const v = `${cmd.cmdVarName}${goPascal(f.name)}Var`
				l.push(`\t${cmd.cmdVarName}.Flags().StringVar(&${v}, ${JSON.stringify(toFlagName(f.name))}, "", ${JSON.stringify(`Path to ${f.name} file`)})`)
				if (f.required) {
					l.push(`\t${cmd.cmdVarName}.MarkFlagRequired(${JSON.stringify(toFlagName(f.name))})`)
				}
			}
		}
	}
	if (cmd.hasLastEventId) {
		l.push(`\t${cmd.cmdVarName}.Flags().StringVar(&${cmd.cmdVarName}LastEventIDVar, "last-event-id", "", "SSE Last-Event-ID resume token")`)
	}
}

function emitQueryFlag(l: string[], cmd: CommandInfo, q: ParamInfo): void {
	const v = `${cmd.cmdVarName}${goPascal(q.name)}Var`
	const t = q.schema.type
	const help = q.enumValues.length > 0
		? `Query param ${q.name} (one of: ${q.enumValues.join(", ")})`
		: `Query param ${q.name}`
	const helpStr = JSON.stringify(help)

	if (t === "integer") {
		const def = typeof q.defaultValue === "number" ? q.defaultValue : 0
		l.push(`\t${cmd.cmdVarName}.Flags().Int64Var(&${v}, ${JSON.stringify(q.flagName)}, ${def}, ${helpStr})`)
	} else if (t === "number") {
		const def = typeof q.defaultValue === "number" ? q.defaultValue : 0
		l.push(`\t${cmd.cmdVarName}.Flags().Float64Var(&${v}, ${JSON.stringify(q.flagName)}, ${def}, ${helpStr})`)
	} else if (t === "boolean") {
		const def = q.defaultValue === true
		l.push(`\t${cmd.cmdVarName}.Flags().BoolVar(&${v}, ${JSON.stringify(q.flagName)}, ${def ? "true" : "false"}, ${helpStr})`)
	} else if (t === "array") {
		const defArr = Array.isArray(q.defaultValue) ? q.defaultValue : []
		const defStr = `[]string{${defArr.map((x) => JSON.stringify(String(x))).join(", ")}}`
		l.push(`\t${cmd.cmdVarName}.Flags().StringSliceVar(&${v}, ${JSON.stringify(q.flagName)}, ${defStr}, ${helpStr})`)
	} else {
		const def = typeof q.defaultValue === "string" ? q.defaultValue : ""
		l.push(`\t${cmd.cmdVarName}.Flags().StringVar(&${v}, ${JSON.stringify(q.flagName)}, ${JSON.stringify(def)}, ${helpStr})`)
	}
	if (q.required) {
		l.push(`\t${cmd.cmdVarName}.MarkFlagRequired(${JSON.stringify(q.flagName)})`)
	}
}

function emitBodyScalarFlag(l: string[], cmd: CommandInfo, s: BodyScalarInfo): void {
	const v = `${cmd.cmdVarName}${goPascal(s.propName)}Var`
	const help = s.enumValues.length > 0
		? `Body field ${s.propName} (one of: ${s.enumValues.join(", ")})`
		: `Body field ${s.propName}`
	const helpStr = JSON.stringify(help)
	if (s.schemaType === "integer") {
		l.push(`\t${cmd.cmdVarName}.Flags().Int64Var(&${v}, ${JSON.stringify(s.flagName)}, 0, ${helpStr})`)
	} else if (s.schemaType === "number") {
		l.push(`\t${cmd.cmdVarName}.Flags().Float64Var(&${v}, ${JSON.stringify(s.flagName)}, 0, ${helpStr})`)
	} else if (s.schemaType === "boolean") {
		l.push(`\t${cmd.cmdVarName}.Flags().BoolVar(&${v}, ${JSON.stringify(s.flagName)}, false, ${helpStr})`)
	} else {
		l.push(`\t${cmd.cmdVarName}.Flags().StringVar(&${v}, ${JSON.stringify(s.flagName)}, "", ${helpStr})`)
	}
}

function emitPreRunE(cmd: CommandInfo): string[] {
	const lines: string[] = []
	/* required body on POST/PUT/PATCH */
	if (
		(cmd.method === "POST" || cmd.method === "PUT" || cmd.method === "PATCH") &&
		(cmd.body.kind === "json-flat" || cmd.body.kind === "json-complex") &&
		cmd.body.required
	) {
		const dataVar = `${cmd.cmdVarName}DataVar`
		const anyFlag =
			cmd.body.kind === "json-flat" && cmd.body.scalars.length > 0
				? cmd.body.scalars.map((s) => `cmd.Flags().Changed(${JSON.stringify(s.flagName)})`).join(" || ")
				: "false"
		lines.push(`if ${dataVar} == "" && !(${anyFlag}) {`)
		lines.push(`\treturn fmt.Errorf("body required: pass --data or per-field flags")`)
		lines.push(`}`)
	}
	/* enum validation: query + body-flat */
	for (const q of cmd.queryParams) {
		if (q.enumValues.length === 0) continue
		if (q.schema.type !== "string") continue
		const v = `${cmd.cmdVarName}${goPascal(q.name)}Var`
		const values = q.enumValues.map((x) => JSON.stringify(x)).join(", ")
		lines.push(`if cmd.Flags().Changed(${JSON.stringify(q.flagName)}) && !slices.Contains([]string{${values}}, ${v}) {`)
		lines.push(`\treturn fmt.Errorf("--${q.flagName} must be one of: ${q.enumValues.join(", ")}")`)
		lines.push(`}`)
	}
	if (cmd.body.kind === "json-flat") {
		for (const s of cmd.body.scalars) {
			if (s.enumValues.length === 0) continue
			if (s.schemaType !== "string") continue
			const v = `${cmd.cmdVarName}${goPascal(s.propName)}Var`
			const values = s.enumValues.map((x) => JSON.stringify(x)).join(", ")
			lines.push(`if cmd.Flags().Changed(${JSON.stringify(s.flagName)}) && !slices.Contains([]string{${values}}, ${v}) {`)
			lines.push(`\treturn fmt.Errorf("--${s.flagName} must be one of: ${s.enumValues.join(", ")}")`)
			lines.push(`}`)
		}
	}
	return lines
}

function emitRunE(l: string[], cmd: CommandInfo, _options: GoCLIOptions): void {
	const ind = "\t\t"
	l.push(`${ind}ctx := cmd.Context()`)
	l.push(`${ind}cfg := configFromCtx(ctx)`)
	l.push(`${ind}apiKey, err := cli.ResolveAPIKey(cfg)`)
	l.push(`${ind}if err != nil { return err }`)
	l.push(`${ind}_ = apiKey`)
	l.push(`${ind}baseURL := cfg.BaseURL`)
	l.push(`${ind}if baseURL == "" { return fmt.Errorf("base URL required: set --base-url, env, or config") }`)
	l.push(`${ind}timeout := 30 * time.Second`)
	l.push(`${ind}if cfg.Timeout != "" {`)
	l.push(`${ind}\tif d, perr := time.ParseDuration(cfg.Timeout); perr == nil { timeout = d }`)
	l.push(`${ind}}`)
	l.push(`${ind}httpClient := &http.Client{Timeout: timeout}`)

	/* path-param local aliases: short Go-idiomatic names used in URL assembly */
	for (const p of cmd.pathParams) {
		const storageVar = `${cmd.cmdVarName}${goPascal(p.name)}Var`
		l.push(`${ind}${p.varName} := ${storageVar}`)
	}

	/* URL assembly */
	const pathExpr = buildPathExpr(cmd)
	l.push(`${ind}reqURL := baseURL + ${pathExpr}`)
	l.push(`${ind}q := url.Values{}`)
	for (const q of cmd.queryParams) {
		if (isLastEventIdName(q.name)) continue
		emitQueryAssembly(l, ind, cmd, q)
	}
	l.push(`${ind}if len(q) > 0 { reqURL += "?" + q.Encode() }`)

	/* body prep */
	let bodyReaderExpr = "nil"
	let contentType = ""
	if (cmd.body.kind === "json-flat") {
		l.push(`${ind}// merge --data + per-prop flags`)
		l.push(`${ind}merged := map[string]any{}`)
		l.push(`${ind}if ${cmd.cmdVarName}DataVar != "" {`)
		l.push(`${ind}\tdataBytes, derr := cli.ReadDataFlag(${cmd.cmdVarName}DataVar)`)
		l.push(`${ind}\tif derr != nil { return derr }`)
		l.push(`${ind}\tif len(dataBytes) > 0 {`)
		l.push(`${ind}\t\tif jerr := json.Unmarshal(dataBytes, &merged); jerr != nil { return fmt.Errorf("parse --data: %w", jerr) }`)
		l.push(`${ind}\t}`)
		l.push(`${ind}}`)
		for (const s of cmd.body.scalars) {
			const v = `${cmd.cmdVarName}${goPascal(s.propName)}Var`
			l.push(`${ind}if cmd.Flags().Changed(${JSON.stringify(s.flagName)}) { merged[${JSON.stringify(s.propName)}] = ${v} }`)
		}
		l.push(`${ind}bodyBytes, merr := json.Marshal(merged)`)
		l.push(`${ind}if merr != nil { return merr }`)
		bodyReaderExpr = "bytes.NewReader(bodyBytes)"
		contentType = "application/json"
	} else if (cmd.body.kind === "json-complex") {
		l.push(`${ind}bodyBytes, derr := cli.ReadDataFlag(${cmd.cmdVarName}DataVar)`)
		l.push(`${ind}if derr != nil { return derr }`)
		bodyReaderExpr = "bytes.NewReader(bodyBytes)"
		contentType = "application/json"
	} else if (cmd.body.kind === "multipart") {
		l.push(`${ind}fields := map[string]string{}`)
		for (const s of cmd.body.scalarFields) {
			const v = `${cmd.cmdVarName}${goPascal(s.propName)}Var`
			if (s.schemaType === "string") {
				l.push(`${ind}if cmd.Flags().Changed(${JSON.stringify(s.flagName)}) { fields[${JSON.stringify(s.propName)}] = ${v} }`)
			} else {
				l.push(`${ind}if cmd.Flags().Changed(${JSON.stringify(s.flagName)}) { fields[${JSON.stringify(s.propName)}] = fmt.Sprint(${v}) }`)
			}
		}
		l.push(`${ind}files := map[string]string{}`)
		if (cmd.body.useGenericFileFlag) {
			const bin = cmd.body.binaryFields[0]
			l.push(`${ind}if ${cmd.cmdVarName}FileVar != "" { files[${JSON.stringify(bin.name)}] = ${cmd.cmdVarName}FileVar }`)
		} else {
			for (const f of cmd.body.binaryFields) {
				const v = `${cmd.cmdVarName}${goPascal(f.name)}Var`
				l.push(`${ind}if ${v} != "" { files[${JSON.stringify(f.name)}] = ${v} }`)
			}
		}
		l.push(`${ind}mpReader, mpCT, mpErr := cli.BuildMultipart(fields, files)`)
		l.push(`${ind}if mpErr != nil { return mpErr }`)
		l.push(`${ind}_ = mpCT`)
		bodyReaderExpr = "mpReader"
		contentType = "__multipart__"
	}

	/* SSE */
	if (cmd.isSSE) {
		l.push(`${ind}req, rerr := http.NewRequestWithContext(ctx, "GET", reqURL, nil)`)
		l.push(`${ind}if rerr != nil { return rerr }`)
		l.push(`${ind}req.Header.Set("Accept", "text/event-stream")`)
		l.push(`${ind}if apiKey != "" { req.Header.Set("Authorization", "Bearer "+apiKey) }`)
		if (cmd.hasLastEventId) {
			l.push(`${ind}if ${cmd.cmdVarName}LastEventIDVar != "" { req.Header.Set("Last-Event-ID", ${cmd.cmdVarName}LastEventIDVar) }`)
		}
		l.push(`${ind}resp, herr := httpClient.Do(req)`)
		l.push(`${ind}if herr != nil { return herr }`)
		l.push(`${ind}defer resp.Body.Close()`)
		l.push(`${ind}it := sdk.ParseSSEStreamExported(ctx, resp)`)
		/* wrap SDK's Seq2[sdk.SSEEvent] → Seq2[cli.SSEEvent] so the runtime stays SDK-agnostic. */
		l.push(`${ind}wrapped := func(yield func(cli.SSEEvent, error) bool) {`)
		l.push(`${ind}\tfor ev, iterErr := range it {`)
		l.push(`${ind}\t\tif !yield(cli.SSEEvent{Data: ev.Data, Event: ev.Event, ID: ev.ID, Retry: ev.Retry}, iterErr) {`)
		l.push(`${ind}\t\t\treturn`)
		l.push(`${ind}\t\t}`)
		l.push(`${ind}\t}`)
		l.push(`${ind}}`)
		l.push(`${ind}return cli.StreamSSE(wrapped, os.Stdout, cfg.Output)`)
		return
	}

	/* regular HTTP */
	l.push(`${ind}req, rerr := http.NewRequestWithContext(ctx, "${cmd.method}", reqURL, ${bodyReaderExpr})`)
	l.push(`${ind}if rerr != nil { return rerr }`)
	if (contentType === "application/json") {
		l.push(`${ind}req.Header.Set("Content-Type", "application/json")`)
	} else if (contentType === "__multipart__") {
		l.push(`${ind}req.Header.Set("Content-Type", mpCT) // multipart/form-data; boundary=...`)
	}
	l.push(`${ind}if apiKey != "" { req.Header.Set("Authorization", "Bearer "+apiKey) }`)
	l.push(`${ind}resp, herr := httpClient.Do(req)`)
	l.push(`${ind}if herr != nil { return herr }`)
	l.push(`${ind}defer resp.Body.Close()`)
	l.push(`${ind}body, berr := io.ReadAll(resp.Body)`)
	l.push(`${ind}if berr != nil { return berr }`)
	l.push(`${ind}if resp.StatusCode >= 400 {`)
	l.push(`${ind}\treturn &sdk.StatusError{StatusCode: resp.StatusCode, Body: body, Response: resp, Message: string(body)}`)
	l.push(`${ind}}`)
	if (cmd.has204) {
		l.push(`${ind}if resp.StatusCode == http.StatusNoContent { return nil }`)
	}
	if (cmd.responseType === "json") {
		l.push(`${ind}var out any`)
		l.push(`${ind}if len(body) > 0 {`)
		l.push(`${ind}\tif jerr := json.Unmarshal(body, &out); jerr != nil { return jerr }`)
		l.push(`${ind}}`)
		l.push(`${ind}return cli.Emit(out, cfg.Output, os.Stdout)`)
	} else {
		l.push(`${ind}return nil`)
	}
}

function buildPathExpr(cmd: CommandInfo): string {
	if (cmd.pathParams.length === 0) return JSON.stringify(cmd.path)
	let expr = JSON.stringify(cmd.path)
	for (const p of cmd.pathParams) {
		expr = expr.replace(`{${p.name}}`, `" + url.PathEscape(${p.varName}) + "`)
	}
	expr = expr.replace(/"" \+ /g, "").replace(/ \+ ""/g, "")
	return expr
}

function querySetStmt(q: ParamInfo, v: string): string {
	const name = JSON.stringify(q.name)
	switch (q.schema.type) {
		case "integer": return `q.Set(${name}, fmt.Sprintf("%d", ${v}))`
		case "number": return `q.Set(${name}, fmt.Sprintf("%g", ${v}))`
		case "boolean": return `q.Set(${name}, fmt.Sprintf("%t", ${v}))`
		case "array": return `for _, v := range ${v} { q.Add(${name}, v) }`
		default: return `q.Set(${name}, ${v})`
	}
}

function emitQueryAssembly(l: string[], ind: string, cmd: CommandInfo, q: ParamInfo): void {
	const v = `${cmd.cmdVarName}${goPascal(q.name)}Var`
	const stmt = querySetStmt(q, v)
	if (q.required) {
		l.push(`${ind}${stmt}`)
		return
	}
	l.push(`${ind}if cmd.Flags().Changed(${JSON.stringify(q.flagName)}) { ${stmt} }`)
}

/* ── emit: main.go ── */

function emitMainFile(options: GoCLIOptions): string {
	const module = resolveModulePath(options)
	const l: string[] = []
	l.push(`// Code generated by honey. DO NOT EDIT.`)
	l.push(`package main`)
	l.push(``)
	l.push(`import (`)
	l.push(`\t"fmt"`)
	l.push(`\t"os"`)
	l.push(``)
	l.push(`\tcli "${module}/internal/cli"`)
	l.push(`\t"${module}/cmd"`)
	l.push(`)`)
	l.push(``)
	l.push(`func main() {`)
	l.push(`\tif err := cmd.Execute(); err != nil {`)
	l.push(`\t\tfmt.Fprintln(os.Stderr, err)`)
	l.push(`\t\tos.Exit(cli.ExitFor(err))`)
	l.push(`\t}`)
	l.push(`}`)
	l.push(``)
	return l.join("\n")
}

/* ── emit: go.mod ── */

function emitGoMod(options: GoCLIOptions, hasEmbeddedSDK: boolean): string {
	const mod = resolveModulePath(options)
	const l: string[] = []
	l.push(`module ${mod}`)
	l.push(``)
	l.push(`go 1.23`)
	l.push(``)
	l.push(`require (`)
	l.push(`\tgithub.com/spf13/cobra v1.8.1`)
	l.push(`\tgithub.com/pelletier/go-toml/v2 v2.2.3`)
	l.push(`\tsigs.k8s.io/yaml v1.4.0`)
	if (!hasEmbeddedSDK && options.sdkModulePath) {
		l.push(`\t${options.sdkModulePath} v0.0.0`)
	}
	if (hasEmbeddedSDK) {
		l.push(`\tnhooyr.io/websocket v1.8.17`)
	}
	l.push(`)`)
	l.push(``)
	if (!hasEmbeddedSDK && options.sdkModulePath) {
		l.push(`replace ${options.sdkModulePath} => ../sdk`)
		l.push(``)
	}
	return l.join("\n")
}

/* ── emit: README.md ── */

function emitReadme(spec: OpenApiSpec, options: GoCLIOptions): string {
	const envPrefix = options.envPrefix ?? toSnakeUpper(options.binaryName)
	const configName = options.configName ?? options.binaryName
	const title = spec.info?.title ?? options.binaryName
	return [
		`# ${options.binaryName}`,
		``,
		`CLI for ${title} — auto-generated by honey.`,
		``,
		`## Install`,
		``,
		"```sh",
		`go build -o ${options.binaryName} ./...`,
		"```",
		``,
		`## Auth`,
		``,
		`Resolution order (high → low):`,
		``,
		`1. \`--api-key <value>\``,
		`2. \`${envPrefix}_API_KEY\` env var`,
		`3. \`~/.config/${configName}/config.toml\` → \`api_key = "..."\``,
		`4. \`$XDG_CONFIG_HOME/${configName}/config.toml\``,
		``,
		`## Global flags`,
		``,
		`- \`--api-key\`, \`--base-url\`, \`--output\` (json|ndjson|yaml|table)`,
		`- \`--verbose\`, \`--config\`, \`--timeout\``,
		``,
		`## Exit codes`,
		``,
		`- 0: success`,
		`- 1: 4xx client error`,
		`- 2: 5xx server error`,
		`- 3: network failure / timeout`,
		`- 4: bad flags / missing api-key`,
		`- 5: unexpected 3xx`,
		``,
	].join("\n")
}

/* ── embedded SDK copy ── */

function copyEmbeddedSDK(
	spec: Record<string, unknown>,
	options: GoCLIOptions,
	outFiles: Record<string, string>,
): void {
	const sdkModule = `${resolveModulePath(options)}/internal/sdk`
	const sdkGen = generateGoSDK(spec, { modulePath: sdkModule })
	for (const [name, content] of Object.entries(sdkGen.files)) {
		/* skip go.mod — CLI has its own */
		if (name === "go.mod") continue
		outFiles[`internal/sdk/${name}`] = content
	}
}

/* ── ParseSSEStreamExported shim ──
 *   The SDK exports parseSSEStream lowercase (package-private).
 *   We need to re-expose it under the SDK package so the CLI's cmd/*.go can call it.
 *   When embedding, add a small sse_export.go into internal/sdk/.
 *   When using external SDK, we still need the same symbol — emit an adapter file. */

function emitSSEExportShim(
	options: GoCLIOptions,
	files: Record<string, string>,
	hasEmbedded: boolean,
): void {
	const shim = [
		`// Code generated by honey. DO NOT EDIT.`,
		`package sdk`,
		``,
		`import (`,
		`\t"context"`,
		`\t"iter"`,
		`\t"net/http"`,
		`)`,
		``,
		`// ParseSSEStreamExported exposes parseSSEStream for CLI consumption.`,
		`func ParseSSEStreamExported(ctx context.Context, resp *http.Response) iter.Seq2[SSEEvent, error] {`,
		`\treturn parseSSEStream(ctx, resp)`,
		`}`,
		``,
	].join("\n")
	if (hasEmbedded) {
		files["internal/sdk/sse_export.go"] = shim
	}
	/* external-SDK mode: consumer's SDK must already export or we rely on ParseSSEStreamExported existing.
	   We include the shim in embed mode only; external mode assumes SDK regenerated w/ same honey. */
}

/* ── public entrypoint ── */

export function generateGoCLI(
	spec: Record<string, unknown>,
	options: GoCLIOptions,
): GeneratedGoCLI {
	const resolved = resolveRefs(spec as Parameters<typeof resolveRefs>[0]) as unknown as OpenApiSpec
	const { groups, skipped, serviceMap } = collectCLIMethods(spec)

	const hasEmbeddedSDK = !options.sdkModulePath
	const files: Record<string, string> = {}

	/* runtime templates → internal/cli/ */
	for (const [name, content] of loadGoCliRuntimeTemplates()) {
		files[`internal/cli/${name}`] = content
	}

	/* main.go */
	files["main.go"] = emitMainFile(options)

	/* cmd/root.go */
	const sortedGroups = [...groups.values()].sort((a, b) => a.resource.localeCompare(b.resource))
	files["cmd/root.go"] = emitRootFile(sortedGroups, options)

	/* cmd/<resource>.go */
	for (const g of sortedGroups) {
		files[`cmd/${g.fileName}`] = emitResourceFile(g, options)
	}

	/* go.mod */
	files["go.mod"] = emitGoMod(options, hasEmbeddedSDK)

	/* README.md */
	files["README.md"] = emitReadme(resolved, options)

	/* SDK embed if sdkModulePath not set */
	if (hasEmbeddedSDK) {
		copyEmbeddedSDK(spec, options, files)
	}
	emitSSEExportShim(options, files, hasEmbeddedSDK)

	return { files, serviceMap, skippedOperations: skipped }
}
