/* Go CLI emitter — generates a complete cobra-based Go CLI module from an OpenAPI 3.1 spec.
 *
 *   - Input is the SDK request model (codegen-sdk-model.ts), shared with the Go SDK emitter.
 *   - Static runtime files (config.go, auth.go, output.go, errors.go, stream.go, multipart.go,
 *     version.go, root.go) are read from ./cli-go/ and copied verbatim under "internal/cli/".
 *   - Per-resource cobra command files are emitted as cmd/<resource>.go.
 *   - URLs, query encoding, SSE parsing and status errors go through the SDK's exported
 *     Honey* helpers, so the CLI sends exactly what the SDK sends.
 *
 * Two SDK wiring modes:
 *   - sdkModulePath set → go.mod emits `require` + `replace`; no internal/sdk/ files.
 *   - sdkModulePath omitted → client-go/* + generated types.go + client.go embedded under
 *     internal/sdk/; emitted imports use "<modulePath>/internal/sdk".
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { OpenApiSpecInput } from "./codegen.ts"
import { collectSDKMethods } from "./codegen.ts"
import { GO_KEYWORDS, GO_PREDECLARED, NameScope, cmpCodeUnit, goExported, goLocal, goString } from "./codegen-lang.ts"
import type { IRParam, IRSchema } from "./codegen-ir.ts"
import { buildSdkModel } from "./codegen-sdk-model.ts"
import type { SdkModel, SdkOp } from "./codegen-sdk-model.ts"
import { detectAuthScheme, generateGoSDK } from "./codegen-go.ts"

const DEFAULT_MODULE_PATH = "example.com/cli"

function resolveModulePath(options: GoCLIOptions): string {
	return options.modulePath ?? DEFAULT_MODULE_PATH
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

type FlagKind = "string" | "int" | "float" | "bool" | "strings"

type Flag = {
	/** Wire name of the param / property. */
	name: string
	flagName: string
	varName: string
	kind: FlagKind
	required: boolean
	enumValues: string[]
	defaultValue: unknown
	where: "path" | "query" | "header" | "body" | "file"
}

type BodyShape =
	| { kind: "none" }
	| { kind: "json-flat"; scalars: Flag[]; required: boolean; dataVar: string }
	| { kind: "json-complex"; required: boolean; dataVar: string }
	| { kind: "form"; scalars: Flag[]; required: boolean }
	| { kind: "multipart"; scalars: Flag[]; files: Flag[] }
	| { kind: "raw"; contentType: string; required: boolean; dataVar: string }

type CommandInfo = {
	op: SdkOp
	cmdVarName: string
	cmdUse: string
	pathFlags: Flag[]
	queryFlags: Flag[]
	headerFlags: Flag[]
	body: BodyShape
	lastEventIdVar?: string
}

type ResourceGroup = {
	resource: string
	cmdUse: string
	/** prefix for per-command var names */
	cmdVarBase: string
	/** the resource's own cobra.Command var */
	groupVar: string
	fileName: string
	commands: CommandInfo[]
}

/* ── case transforms ── */

/** Converts camelCase / snake_case / acronyms to kebab-case (e.g. "APIKey" → "api-key"). */
export function toKebab(s: string): string {
	if (!s) return s
	return s
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/[^A-Za-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase()
}

export function toFlagName(paramName: string): string {
	return toKebab(paramName) || "value"
}

/** Upper snake case for env var: toSnakeUpper("project-id") → "PROJECT_ID". */
function toSnakeUpper(s: string): string {
	return toKebab(s).toUpperCase().replace(/-/g, "_")
}

export function envVarFromFlag(flagName: string, envPrefix: string): string {
	return `${envPrefix}_${toSnakeUpper(flagName)}`
}

/* ── runtime template loader ── */

let runtimeCache: Map<string, string> | null = null

/** Reads static .go runtime files from ./cli-go/ and caches them. */
export function loadGoCliRuntimeTemplates(): Map<string, string> {
	if (runtimeCache) return runtimeCache
	const names = ["config.go", "auth.go", "output.go", "errors.go", "stream.go", "multipart.go", "version.go", "root.go"]
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

/* ── naming ── */

/** Persistent flags on the root command, plus cobra's own. A command flag must not shadow them. */
const GLOBAL_FLAGS = ["api-key", "base-url", "output", "verbose", "config", "timeout", "help", "version"]

/** Identifiers every cmd/*.go file shares: imports and the package-level names root.go declares. */
const CMD_PACKAGE_NAMES = [
	...GO_KEYWORDS,
	...GO_PREDECLARED,
	"rootCmd",
	"Execute",
	"configFromCtx",
	"configKey",
	"runtimeConfig",
	"EnvPrefix",
	"ConfigName",
	"DefaultBaseURL",
	"AuthHeaderName",
	"AuthHeaderPrefix",
	"newHTTPClient",
	"doJSON",
	"init",
]

/** File stems Go treats specially, or that the generator writes itself. */
const GOOS_GOARCH =
	/_(aix|android|darwin|dragonfly|freebsd|hurd|illumos|ios|js|linux|nacl|netbsd|openbsd|plan9|solaris|wasip1|windows|zos|386|amd64|arm|arm64|loong64|mips|mipsle|mips64|mips64le|ppc64|ppc64le|riscv64|s390x|wasm|test)$/

function resourceFileName(resource: string, taken: NameScope): string {
	let stem = resource.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[-_.]+/, "")
	if (stem === "" || /^(root|main|doc)$/i.test(stem) || GOOS_GOARCH.test(stem.toLowerCase())) stem = `res_${stem}`
	return `${taken.claim(stem)}.go`
}

function flagKind(schema: IRSchema, resolve: (s: IRSchema) => IRSchema): FlagKind {
	let s = resolve(schema)
	if (s.kind === "nullable") s = resolve(s.inner)
	if (s.kind === "array") {
		return "strings"
	}
	if (s.kind === "scalar") {
		if (s.type === "integer") return "int"
		if (s.type === "number") return "float"
		if (s.type === "boolean") return "bool"
	}
	if (s.kind === "const" && typeof s.value === "boolean") return "bool"
	return "string"
}

function enumOf(schema: IRSchema, resolve: (s: IRSchema) => IRSchema): string[] {
	let s = resolve(schema)
	if (s.kind === "nullable") s = resolve(s.inner)
	if (s.kind === "scalar" && s.enum) return s.enum.map(String)
	return []
}

function isScalarSchema(schema: IRSchema, resolve: (s: IRSchema) => IRSchema): boolean {
	let s = resolve(schema)
	if (s.kind === "nullable") s = resolve(s.inner)
	return s.kind === "scalar" || s.kind === "const"
}

/** `schema.default` of a declared parameter; the IR does not carry defaults. */
function rawParamDefault(op: SdkOp, name: string, where: string): unknown {
	const params = (op.raw.parameters as Array<Record<string, unknown>> | undefined) ?? []
	const p = params.find((x) => x.name === name && x.in === where)
	return (p?.schema as Record<string, unknown> | undefined)?.default
}

/** Go literal for a flag default, or the zero value. */
function flagDefault(f: Flag): string {
	const d = f.defaultValue
	switch (f.kind) {
		case "int":
			return typeof d === "number" && Number.isInteger(d) ? String(d) : "0"
		case "float":
			return typeof d === "number" && Number.isFinite(d) ? String(d) : "0"
		case "bool":
			return d === true ? "true" : "false"
		case "strings":
			return Array.isArray(d) ? `[]string{${d.map((x) => goString(String(x))).join(", ")}}` : "nil"
		default:
			return typeof d === "string" ? goString(d) : `""`
	}
}

/* ── command collection ── */

function collectCLIMethods(model: SdkModel, pkg: NameScope): { groups: Map<string, ResourceGroup>; skipped: string[] } {
	const groups = new Map<string, ResourceGroup>()
	const skipped: string[] = []
	const seenCmdPaths = new Map<string, string>()
	const fileNames = new NameScope(["root", "main"], (n) => n.toLowerCase())
	const { resolve } = model

	for (const op of model.ops) {
		if (op.stream === "ws" || op.stream === "realtime") {
			skipped.push(op.id)
			continue
		}

		const segments = op.segments
		const resource = segments[0] ?? op.id
		/* Top-level ops (single segment) become `<resource> call` — cobra rejects leading dashes. */
		const actionSegments = segments.length === 1 ? ["call"] : segments.slice(1).map((seg) => toKebab(seg))
		const cmdUse = actionSegments.join("-")

		/* collision check: (resource, cmdUse) must be unique */
		const key = `${resource}|${cmdUse}`
		const prior = seenCmdPaths.get(key)
		if (prior !== undefined) {
			throw new Error(
				`go-cli codegen: command path collision for ${resource} ${cmdUse} — operations: ${prior}, ${op.id}`,
			)
		}
		seenCmdPaths.set(key, op.id)

		let group = groups.get(resource)
		if (!group) {
			const cmdVarBase = goLocal(resource)
			group = {
				cmdUse: toKebab(resource) || "resource",
				cmdVarBase,
				groupVar: pkg.claim(`${cmdVarBase}Cmd`),
				commands: [],
				fileName: resourceFileName(resource, fileNames),
				resource,
			}
			groups.set(resource, group)
		}

		const cmdVarName = pkg.claim(`${group.cmdVarBase}${goExported(cmdUse)}Cmd`)
		const flagScope = new NameScope(GLOBAL_FLAGS)
		const varFor = (flag: string) => pkg.claim(`${cmdVarName}${goExported(flag)}Var`)
		const claimFlag = (name: string, prefix: string): string => {
			const base = toFlagName(name)
			return flagScope.has(base) ? flagScope.claim(`${prefix}-${base}`) : flagScope.claim(base)
		}
		const mkFlag = (p: IRParam, where: Flag["where"], prefix: string): Flag => {
			const flagName = claimFlag(p.name, prefix)
			return {
				defaultValue: where === "query" || where === "header" ? rawParamDefault(op, p.name, where) : undefined,
				enumValues: enumOf(p.schema, resolve),
				flagName,
				kind: flagKind(p.schema, resolve),
				name: p.name,
				required: where === "path" || p.required === true,
				varName: varFor(flagName),
				where,
			}
		}

		/* path flags claim first: a path param keeps its plain flag name */
		const pathFlags = op.pathParams.map((p) => ({ ...mkFlag(p, "path", "path"), kind: "string" as const }))
		const queryFlags: Flag[] = []
		let lastEventIdVar: string | undefined
		for (const q of op.query) {
			if (op.stream === "sse" && /^last[-_]?event[-_]?id$/i.test(q.name)) continue
			queryFlags.push(mkFlag(q, "query", "query"))
		}
		const headerFlags = op.headers.map((h) => mkFlag(h, "header", "header"))
		if (op.stream === "sse") {
			const flagName = flagScope.claim("last-event-id")
			lastEventIdVar = varFor(flagName)
		}

		let body: BodyShape = { kind: "none" }
		const b = op.body
		if (b) {
			const scalarFlags = (schema: IRSchema): Flag[] | null => {
				const s = resolve(schema)
				if (s.kind !== "object") return null
				const out: Flag[] = []
				for (const f of s.fields) {
					if (!isScalarSchema(f.schema, resolve)) return null
					out.push(mkFlag({ name: f.name, required: false, schema: f.schema }, "body", "body"))
				}
				return out
			}
			if (b.kind === "json") {
				const dataFlag = flagScope.claim("data")
				const dataVar = varFor(dataFlag)
				const scalars = scalarFlags(b.schema)
				body = scalars
					? { dataVar, kind: "json-flat", required: b.required, scalars }
					: { dataVar, kind: "json-complex", required: b.required }
			} else if (b.kind === "form") {
				body = { kind: "form", required: b.required, scalars: scalarFlags(b.schema) ?? [] }
			} else if (b.kind === "multipart") {
				const scalars: Flag[] = []
				const files: Flag[] = []
				const fileParts = b.parts.filter((p) => p.type === "file")
				for (const part of b.parts) {
					if (part.type === "file") {
						const flagName = fileParts.length === 1 ? flagScope.claim("file") : claimFlag(part.name, "file")
						files.push({
							defaultValue: undefined,
							enumValues: [],
							flagName,
							kind: "string",
							name: part.name,
							required: fileParts.length === 1 && b.required,
							varName: varFor(flagName),
							where: "file",
						})
					} else if (part.schema && isScalarSchema(part.schema, resolve)) {
						scalars.push(mkFlag({ name: part.name, required: false, schema: part.schema }, "body", "body"))
					}
				}
				body = { files, kind: "multipart", scalars }
			} else {
				const dataFlag = flagScope.claim("data")
				body = { contentType: b.contentType, dataVar: varFor(dataFlag), kind: "raw", required: b.required }
			}
		}

		group.commands.push({ body, cmdUse, cmdVarName, headerFlags, lastEventIdVar, op, pathFlags, queryFlags })
	}

	return { groups, skipped }
}

/* ── emit: cmd/root.go ── */

function emitRootFile(
	groups: ResourceGroup[],
	options: GoCLIOptions,
	auth: { headerName: string; prefix: string },
): string {
	const envPrefix = options.envPrefix ?? toSnakeUpper(options.binaryName)
	const configName = options.configName ?? options.binaryName
	const defaultBase = options.defaultBaseURL ?? ""

	const l: string[] = []
	l.push(`// Code generated by honey. DO NOT EDIT.`)
	l.push(`package cmd`)
	l.push(``)
	l.push(`import (`)
	l.push(`\t"context"`)
	l.push(`\t"net/http"`)
	l.push(`\t"time"`)
	l.push(``)
	l.push(`\t"github.com/spf13/cobra"`)
	l.push(``)
	l.push(`\tcli ${goString(cliImportPath(options))}`)
	l.push(`)`)
	l.push(``)
	l.push(`// EnvPrefix is the prefix used for all <PREFIX>_<FLAG> environment variables.`)
	l.push(`const EnvPrefix = ${goString(envPrefix)}`)
	l.push(``)
	l.push(`// ConfigName is the directory name under $XDG_CONFIG_HOME / ~/.config for the config file.`)
	l.push(`const ConfigName = ${goString(configName)}`)
	l.push(``)
	l.push(`// DefaultBaseURL is used when neither --base-url, env var, nor the config file provide one.`)
	l.push(`const DefaultBaseURL = ${goString(defaultBase)}`)
	l.push(``)
	l.push(`// AuthHeaderName and AuthHeaderPrefix come from the API's security scheme.`)
	l.push(`const AuthHeaderName = ${goString(auth.headerName)}`)
	l.push(``)
	l.push(`const AuthHeaderPrefix = ${goString(auth.prefix)}`)
	l.push(``)
	l.push(`type configKey struct{}`)
	l.push(``)
	l.push(`// runtimeConfig is the resolved CLI config stashed on the cobra context.`)
	l.push(`type runtimeConfig struct {`)
	l.push(`\tCfg cli.Config`)
	l.push(`}`)
	l.push(``)
	l.push(`// rootCmd is the top-level cobra command for the CLI.`)
	l.push(`var rootCmd = &cobra.Command{`)
	l.push(`\tUse:     ${goString(options.binaryName)},`)
	l.push(`\tShort:   ${goString(options.description ?? `${options.binaryName} CLI`)},`)
	l.push(`\tVersion: cli.Version,`)
	l.push(`\tSilenceUsage: true,`)
	l.push(`\tSilenceErrors: true,`)
	l.push(`\tPersistentPreRunE: func(cmd *cobra.Command, args []string) error {`)
	l.push(`\t\tcfg, err := cli.LoadConfig(cmd.Flags(), EnvPrefix, ConfigName)`)
	l.push(`\t\tif err != nil {`)
	l.push(`\t\t\treturn err`)
	l.push(`\t\t}`)
	l.push(`\t\tif cfg.BaseURL == "" {`)
	l.push(`\t\t\tcfg.BaseURL = DefaultBaseURL`)
	l.push(`\t\t}`)
	l.push(`\t\tif _, err := time.ParseDuration(cfg.Timeout); err != nil {`)
	l.push(`\t\t\treturn cli.Usage(err)`)
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
	l.push(`// newHTTPClient returns a client without an overall timeout: regular calls`)
	l.push(`// bound themselves with --timeout, streams and uploads do not.`)
	l.push(`func newHTTPClient() *http.Client {`)
	l.push(`\treturn &http.Client{`)
	l.push(`\t\tCheckRedirect: func(req *http.Request, via []*http.Request) error {`)
	l.push(`\t\t\t/* never forward the API key to another host */`)
	l.push(`\t\t\tif len(via) >= 10 || req.URL.Host != via[0].URL.Host || req.URL.Scheme != via[0].URL.Scheme {`)
	l.push(`\t\t\t\treturn http.ErrUseLastResponse`)
	l.push(`\t\t\t}`)
	l.push(`\t\t\treturn nil`)
	l.push(`\t\t},`)
	l.push(`\t}`)
	l.push(`}`)
	l.push(``)
	l.push(`func init() {`)
	l.push(
		`\trootCmd.PersistentFlags().String("api-key", "", "API key (overrides env + config file; visible to other local users in the process list, prefer the env var)")`,
	)
	l.push(`\trootCmd.PersistentFlags().String("base-url", "", "Override API base URL")`)
	l.push(`\trootCmd.PersistentFlags().String("output", "json", "Output mode: json|ndjson|yaml|table")`)
	l.push(`\trootCmd.PersistentFlags().Bool("verbose", false, "Print request metadata to stderr")`)
	l.push(`\trootCmd.PersistentFlags().String("config", "", "Path to config file")`)
	l.push(
		`\trootCmd.PersistentFlags().String("timeout", "30s", "Request timeout (Go duration); streams are not bounded")`,
	)
	l.push(`\trootCmd.SetFlagErrorFunc(func(cmd *cobra.Command, err error) error {`)
	l.push(`\t\treturn cli.Usage(err)`)
	l.push(`\t})`)
	for (const g of groups) l.push(`\trootCmd.AddCommand(${g.groupVar})`)
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
	const body: string[] = []

	const resShort = group.commands[0]?.op.summary || `${group.cmdUse} commands`
	body.push(`var ${group.groupVar} = &cobra.Command{`)
	body.push(`\tUse:   ${goString(group.cmdUse)},`)
	body.push(`\tShort: ${goString(firstLine(resShort))},`)
	body.push(`}`)
	body.push(``)

	for (const cmd of group.commands) emitCommand(body, cmd)

	/* init() wires subcommands + registers their flags */
	body.push(`func init() {`)
	for (const cmd of group.commands) body.push(`\t${group.groupVar}.AddCommand(${cmd.cmdVarName})`)
	for (const cmd of group.commands) emitFlagRegistrations(body, cmd)
	body.push(`}`)
	body.push(``)

	const src = body.join("\n")
	const imports: string[] = []
	const uses = (re: RegExp) => re.test(src)
	if (uses(/\bcontext\./)) imports.push("context")
	if (uses(/\bbytes\./)) imports.push("bytes")
	if (uses(/\bjson\./)) imports.push("encoding/json")
	if (uses(/\berrors\./)) imports.push("errors")
	if (uses(/\bfmt\./)) imports.push("fmt")
	if (uses(/\bio\./)) imports.push("io")
	if (uses(/\bhttp\./)) imports.push("net/http")
	if (uses(/\burl\./)) imports.push("net/url")
	if (uses(/\bos\./)) imports.push("os")
	if (uses(/\bslices\./)) imports.push("slices")
	if (uses(/\bstrconv\./)) imports.push("strconv")
	if (uses(/\bstrings\./)) imports.push("strings")
	if (uses(/\btime\./)) imports.push("time")

	const l: string[] = []
	l.push(`// Code generated by honey. DO NOT EDIT.`)
	l.push(`package cmd`)
	l.push(``)
	l.push(`import (`)
	for (const p of imports.sort(cmpCodeUnit)) l.push(`\t"${p}"`)
	l.push(``)
	l.push(`\t"github.com/spf13/cobra"`)
	l.push(``)
	l.push(`\tcli ${goString(cliImportPath(options))}`)
	if (uses(/\bsdk\./)) l.push(`\tsdk ${goString(sdkImportPath(options))}`)
	l.push(`)`)
	l.push(``)
	l.push(src)
	return l.join("\n")
}

function firstLine(s: string): string {
	return s.split(/\r\n|\r|\n/)[0] ?? ""
}

function allFlags(cmd: CommandInfo): Flag[] {
	const out = [...cmd.pathFlags, ...cmd.queryFlags, ...cmd.headerFlags]
	if (cmd.body.kind === "json-flat" || cmd.body.kind === "form") out.push(...cmd.body.scalars)
	if (cmd.body.kind === "multipart") out.push(...cmd.body.scalars, ...cmd.body.files)
	return out
}

function goVarType(kind: FlagKind): string {
	switch (kind) {
		case "int":
			return "int64"
		case "float":
			return "float64"
		case "bool":
			return "bool"
		case "strings":
			return "[]string"
		default:
			return "string"
	}
}

/** Emits var declarations for every flag-backing Go variable + the cobra.Command literal. */
function emitCommand(l: string[], cmd: CommandInfo): void {
	for (const f of allFlags(cmd)) l.push(`var ${f.varName} ${goVarType(f.kind)}`)
	if (cmd.body.kind === "json-flat" || cmd.body.kind === "json-complex" || cmd.body.kind === "raw") {
		l.push(`var ${cmd.body.dataVar} string`)
	}
	if (cmd.lastEventIdVar) l.push(`var ${cmd.lastEventIdVar} string`)
	l.push(``)

	const shortDesc = firstLine(cmd.op.summary) || cmd.cmdUse
	l.push(`var ${cmd.cmdVarName} = &cobra.Command{`)
	l.push(`\tUse:   ${goString(cmd.cmdUse)},`)
	l.push(`\tShort: ${goString(shortDesc)},`)
	if (cmd.op.description) l.push(`\tLong:  ${goString(cmd.op.description)},`)

	const preRunELines = emitPreRunE(cmd)
	if (preRunELines.length > 0) {
		l.push(`\tPreRunE: func(cmd *cobra.Command, args []string) error {`)
		for (const line of preRunELines) l.push(`\t\t${line}`)
		l.push(`\t\treturn nil`)
		l.push(`\t},`)
	}

	l.push(`\tRunE: func(cmd *cobra.Command, args []string) error {`)
	emitRunE(l, cmd)
	l.push(`\t},`)
	l.push(`}`)
	l.push(``)
}

function emitFlagRegistrations(l: string[], cmd: CommandInfo): void {
	const c = cmd.cmdVarName
	for (const f of allFlags(cmd)) {
		let help: string
		switch (f.where) {
			case "path":
				help = `Path parameter ${f.name}`
				break
			case "query":
				help = `Query param ${f.name}`
				break
			case "header":
				help = `Header ${f.name}`
				break
			case "file":
				help = `Path to the ${f.name} file to upload`
				break
			default:
				help = `Body field ${f.name}`
		}
		if (f.enumValues.length > 0) help += ` (one of: ${f.enumValues.join(", ")})`
		const h = goString(help)
		const n = goString(f.flagName)
		const def = flagDefault(f)
		switch (f.kind) {
			case "int":
				l.push(`\t${c}.Flags().Int64Var(&${f.varName}, ${n}, ${def}, ${h})`)
				break
			case "float":
				l.push(`\t${c}.Flags().Float64Var(&${f.varName}, ${n}, ${def}, ${h})`)
				break
			case "bool":
				l.push(`\t${c}.Flags().BoolVar(&${f.varName}, ${n}, ${def}, ${h})`)
				break
			case "strings":
				l.push(`\t${c}.Flags().StringSliceVar(&${f.varName}, ${n}, ${def}, ${h})`)
				break
			default:
				l.push(`\t${c}.Flags().StringVar(&${f.varName}, ${n}, ${def}, ${h})`)
		}
		if (f.required) l.push(`\t${c}.MarkFlagRequired(${n})`)
	}
	if (cmd.body.kind === "json-flat" || cmd.body.kind === "json-complex" || cmd.body.kind === "raw") {
		l.push(`\t${c}.Flags().StringVar(&${cmd.body.dataVar}, "data", "", "Request body: literal, @file, or - for stdin")`)
	}
	if (cmd.lastEventIdVar) {
		l.push(`\t${c}.Flags().StringVar(&${cmd.lastEventIdVar}, "last-event-id", "", "SSE Last-Event-ID resume token")`)
	}
}

function emitPreRunE(cmd: CommandInfo): string[] {
	const lines: string[] = []
	if (
		(cmd.body.kind === "json-flat" || cmd.body.kind === "json-complex" || cmd.body.kind === "raw") &&
		cmd.body.required
	) {
		const anyFlag =
			cmd.body.kind === "json-flat" && cmd.body.scalars.length > 0
				? cmd.body.scalars.map((s) => `cmd.Flags().Changed(${goString(s.flagName)})`).join(" || ")
				: "false"
		lines.push(`if ${cmd.body.dataVar} == "" && !(${anyFlag}) {`)
		lines.push(`\treturn cli.Usage(errors.New("body required: pass --data or per-field flags"))`)
		lines.push(`}`)
	}
	for (const f of allFlags(cmd)) {
		if (f.enumValues.length === 0 || f.kind !== "string") continue
		const values = f.enumValues.map(goString).join(", ")
		const msg = goString(`--${f.flagName} must be one of: ${f.enumValues.join(", ")}`)
		lines.push(
			`if cmd.Flags().Changed(${goString(f.flagName)}) && !slices.Contains([]string{${values}}, ${f.varName}) {`,
		)
		lines.push(`\treturn cli.Usage(errors.New(${msg}))`)
		lines.push(`}`)
	}
	return lines
}

/** Go expression rendering a flag variable as a wire string. */
function scalarString(f: Flag, expr = f.varName): string {
	switch (f.kind) {
		case "int":
			return `strconv.FormatInt(${expr}, 10)`
		case "float":
			return `strconv.FormatFloat(${expr}, 'g', -1, 64)`
		case "bool":
			return `strconv.FormatBool(${expr})`
		default:
			return expr
	}
}

function emitRunE(l: string[], cmd: CommandInfo): void {
	const ind = "\t\t"
	const { op } = cmd
	l.push(`${ind}ctx := cmd.Context()`)
	l.push(`${ind}cfg := configFromCtx(ctx)`)
	l.push(`${ind}apiKey, err := cli.ResolveAPIKey(cfg)`)
	l.push(`${ind}if err != nil {`)
	l.push(`${ind}\treturn err`)
	l.push(`${ind}}`)
	l.push(`${ind}if cfg.BaseURL == "" {`)
	l.push(`${ind}\treturn cli.Usage(errors.New("base URL required: set --base-url, env, or config"))`)
	l.push(`${ind}}`)

	/* path */
	if (cmd.pathFlags.length > 0) {
		const params = cmd.pathFlags.map((f) => `${goString(f.name)}: ${f.varName}`).join(", ")
		l.push(`${ind}path, err := sdk.HoneyExpandPath(${goString(op.path)}, map[string]string{${params}})`)
		l.push(`${ind}if err != nil {`)
		l.push(`${ind}\treturn cli.Usage(err)`)
		l.push(`${ind}}`)
	} else {
		l.push(`${ind}path := ${goString(op.path)}`)
	}

	/* query: a required flag is always sent, an optional one only when set */
	l.push(`${ind}var query [][2]string`)
	for (const f of cmd.queryFlags) {
		const guard = f.required ? "" : `if cmd.Flags().Changed(${goString(f.flagName)}) `
		if (f.kind === "strings") {
			l.push(`${ind}${guard}{`)
			l.push(`${ind}\tfor _, v := range ${f.varName} {`)
			l.push(`${ind}\t\tquery = append(query, [2]string{${goString(f.name)}, v})`)
			l.push(`${ind}\t}`)
			l.push(`${ind}}`)
		} else {
			l.push(`${ind}${guard}{`)
			l.push(`${ind}\tquery = append(query, [2]string{${goString(f.name)}, ${scalarString(f)}})`)
			l.push(`${ind}}`)
		}
	}
	l.push(`${ind}reqURL, err := sdk.HoneyBuildURL(cfg.BaseURL, path, query)`)
	l.push(`${ind}if err != nil {`)
	l.push(`${ind}\treturn cli.Usage(err)`)
	l.push(`${ind}}`)

	/* body */
	let bodyExpr = "nil"
	let contentTypeExpr = ""
	const b = cmd.body
	if (b.kind === "json-flat") {
		l.push(`${ind}merged := map[string]any{}`)
		l.push(`${ind}if ${b.dataVar} != "" {`)
		l.push(`${ind}\tdataBytes, derr := cli.ReadDataFlag(${b.dataVar})`)
		l.push(`${ind}\tif derr != nil {`)
		l.push(`${ind}\t\treturn cli.Usage(derr)`)
		l.push(`${ind}\t}`)
		l.push(`${ind}\tif len(dataBytes) > 0 {`)
		l.push(`${ind}\t\tif jerr := json.Unmarshal(dataBytes, &merged); jerr != nil {`)
		l.push(`${ind}\t\t\treturn cli.Usage(fmt.Errorf("parse --data: %w", jerr))`)
		l.push(`${ind}\t\t}`)
		l.push(`${ind}\t}`)
		l.push(`${ind}}`)
		for (const s of b.scalars) {
			l.push(`${ind}if cmd.Flags().Changed(${goString(s.flagName)}) {`)
			l.push(`${ind}\tmerged[${goString(s.name)}] = ${s.varName}`)
			l.push(`${ind}}`)
		}
		l.push(`${ind}bodyBytes, err := json.Marshal(merged)`)
		l.push(`${ind}if err != nil {`)
		l.push(`${ind}\treturn err`)
		l.push(`${ind}}`)
		bodyExpr = "bytes.NewReader(bodyBytes)"
		contentTypeExpr = goString(op.body?.contentType ?? "application/json")
	} else if (b.kind === "json-complex" || b.kind === "raw") {
		l.push(`${ind}bodyBytes, err := cli.ReadDataFlag(${b.dataVar})`)
		l.push(`${ind}if err != nil {`)
		l.push(`${ind}\treturn cli.Usage(err)`)
		l.push(`${ind}}`)
		bodyExpr = "bytes.NewReader(bodyBytes)"
		contentTypeExpr = goString(op.body?.contentType ?? "application/json")
	} else if (b.kind === "form") {
		l.push(`${ind}form := url.Values{}`)
		for (const s of b.scalars) {
			l.push(`${ind}if cmd.Flags().Changed(${goString(s.flagName)}) {`)
			l.push(`${ind}\tform.Set(${goString(s.name)}, ${scalarString(s)})`)
			l.push(`${ind}}`)
		}
		bodyExpr = "strings.NewReader(form.Encode())"
		contentTypeExpr = `"application/x-www-form-urlencoded"`
	} else if (b.kind === "multipart") {
		l.push(`${ind}fields := map[string]string{}`)
		for (const s of b.scalars) {
			l.push(`${ind}if cmd.Flags().Changed(${goString(s.flagName)}) {`)
			l.push(`${ind}\tfields[${goString(s.name)}] = ${scalarString(s)}`)
			l.push(`${ind}}`)
		}
		l.push(`${ind}files := map[string]string{}`)
		for (const f of b.files) {
			l.push(`${ind}if ${f.varName} != "" {`)
			l.push(`${ind}\tfiles[${goString(f.name)}] = ${f.varName}`)
			l.push(`${ind}}`)
		}
		l.push(`${ind}mpReader, mpCT, err := cli.BuildMultipart(fields, files)`)
		l.push(`${ind}if err != nil {`)
		l.push(`${ind}\treturn err`)
		l.push(`${ind}}`)
		bodyExpr = "mpReader"
		contentTypeExpr = "mpCT"
	}

	/* regular calls get --timeout; streams and uploads only stop on ^C */
	const bounded = op.stream === null && b.kind !== "multipart"
	if (bounded) {
		l.push(`${ind}timeout, err := time.ParseDuration(cfg.Timeout)`)
		l.push(`${ind}if err != nil {`)
		l.push(`${ind}\treturn cli.Usage(err)`)
		l.push(`${ind}}`)
		l.push(`${ind}ctx, cancel := context.WithTimeout(ctx, timeout)`)
		l.push(`${ind}defer cancel()`)
	}

	l.push(`${ind}req, err := http.NewRequestWithContext(ctx, ${goString(op.method)}, reqURL, ${bodyExpr})`)
	l.push(`${ind}if err != nil {`)
	l.push(`${ind}\treturn err`)
	l.push(`${ind}}`)
	if (contentTypeExpr) l.push(`${ind}req.Header.Set("Content-Type", ${contentTypeExpr})`)
	for (const f of cmd.headerFlags) {
		const guard = f.required ? "" : `if cmd.Flags().Changed(${goString(f.flagName)}) `
		const value = f.kind === "strings" ? `strings.Join(${f.varName}, ",")` : scalarString(f)
		l.push(`${ind}${guard}{`)
		l.push(`${ind}\treq.Header.Set(${goString(f.name)}, ${value})`)
		l.push(`${ind}}`)
	}
	l.push(`${ind}cli.ApplyAuth(req.Header, AuthHeaderName, AuthHeaderPrefix, apiKey)`)

	if (op.stream === "sse") {
		l.push(`${ind}req.Header.Set("Accept", "text/event-stream")`)
		if (cmd.lastEventIdVar) {
			l.push(`${ind}if ${cmd.lastEventIdVar} != "" {`)
			l.push(`${ind}\treq.Header.Set("Last-Event-ID", ${cmd.lastEventIdVar})`)
			l.push(`${ind}}`)
		}
		l.push(`${ind}resp, err := newHTTPClient().Do(req)`)
		l.push(`${ind}if err != nil {`)
		l.push(`${ind}\treturn err`)
		l.push(`${ind}}`)
		/* wrap SDK's Seq2[sdk.SSEEvent] → Seq2[cli.SSEEvent] so the runtime stays SDK-agnostic. */
		l.push(`${ind}it := sdk.HoneyParseSSEStream(ctx, resp)`)
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

	l.push(`${ind}resp, err := newHTTPClient().Do(req)`)
	l.push(`${ind}if err != nil {`)
	l.push(`${ind}\treturn err`)
	l.push(`${ind}}`)
	l.push(`${ind}defer resp.Body.Close()`)
	l.push(`${ind}body, err := io.ReadAll(resp.Body)`)
	l.push(`${ind}if err != nil {`)
	l.push(`${ind}\treturn err`)
	l.push(`${ind}}`)
	l.push(`${ind}if err := sdk.HoneyRaiseForStatus(resp, body); err != nil {`)
	l.push(`${ind}\treturn err`)
	l.push(`${ind}}`)
	const kind = op.success.kind
	if (kind === "json") {
		l.push(`${ind}out, err := cli.DecodeJSON(body)`)
		l.push(`${ind}if err != nil {`)
		l.push(`${ind}\treturn err`)
		l.push(`${ind}}`)
		l.push(`${ind}return cli.Emit(out, cfg.Output, os.Stdout)`)
	} else if (kind === "text" || kind === "binary") {
		l.push(`${ind}_, err = os.Stdout.Write(body)`)
		l.push(`${ind}return err`)
	} else {
		l.push(`${ind}return nil`)
	}
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
	l.push(`\tcli ${goString(`${module}/internal/cli`)}`)
	l.push(`\t${goString(`${module}/cmd`)}`)
	l.push(`)`)
	l.push(``)
	l.push(`func main() {`)
	l.push(`\tif err := cmd.Execute(); err != nil {`)
	l.push(`\t\tfmt.Fprintln(os.Stderr, cli.Sanitize(err.Error()))`)
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

function emitReadme(spec: Record<string, unknown>, options: GoCLIOptions): string {
	const envPrefix = options.envPrefix ?? toSnakeUpper(options.binaryName)
	const configName = options.configName ?? options.binaryName
	const info = (spec.info ?? {}) as Record<string, unknown>
	const title = typeof info.title === "string" ? info.title : options.binaryName
	return [
		`# ${options.binaryName}`,
		``,
		`CLI for ${title} — auto-generated by honey.`,
		``,
		`## Install`,
		``,
		"```sh",
		`go build -ldflags "-X ${resolveModulePath(options)}/internal/cli.Version=1.0.0" -o ${options.binaryName} .`,
		"```",
		``,
		`## Auth`,
		``,
		`Resolution order (high → low):`,
		``,
		`1. \`--api-key <value>\` (visible in the process list; prefer the env var)`,
		`2. \`${envPrefix}_API_KEY\` env var`,
		`3. \`~/.config/${configName}/config.toml\` → \`api_key = "..."\` (keep it \`chmod 600\`)`,
		`4. \`$XDG_CONFIG_HOME/${configName}/config.toml\``,
		``,
		`## Global flags`,
		``,
		`- \`--api-key\`, \`--base-url\`, \`--output\` (json|ndjson|yaml|table)`,
		`- \`--verbose\`, \`--config\`, \`--timeout\` (regular calls only; streams and uploads are not bounded)`,
		``,
		`## Exit codes`,
		``,
		`- 0: success`,
		`- 1: 4xx client error`,
		`- 2: 5xx server error`,
		`- 3: network failure / timeout`,
		`- 4: bad flags / bad config / missing api-key`,
		`- 5: unexpected 3xx (redirects to another host are not followed)`,
		``,
	].join("\n")
}

/* ── embedded SDK copy ── */

function copyEmbeddedSDK(spec: Record<string, unknown>, options: GoCLIOptions, outFiles: Record<string, string>): void {
	const sdkModule = `${resolveModulePath(options)}/internal/sdk`
	const sdkGen = generateGoSDK(spec, { modulePath: sdkModule })
	for (const [name, content] of Object.entries(sdkGen.files)) {
		/* skip go.mod — CLI has its own */
		if (name === "go.mod") continue
		outFiles[`internal/sdk/${name}`] = content
	}
}

/* ── ParseSSEStreamExported shim ──
 * Older generated CLIs call ParseSSEStreamExported; kept so they keep compiling against
 * an embedded SDK. New code uses the Honey* helpers in export.go. */

function emitSSEExportShim(files: Record<string, string>, hasEmbedded: boolean): void {
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
	if (hasEmbedded) files["internal/sdk/sse_export.go"] = shim
}

/* ── public entrypoint ── */

export function generateGoCLI(spec: Record<string, unknown>, options: GoCLIOptions): GeneratedGoCLI {
	const input = spec as unknown as OpenApiSpecInput
	const model = buildSdkModel(input)
	const { serviceMap } = collectSDKMethods(input)
	const pkg = new NameScope(CMD_PACKAGE_NAMES)
	const { groups, skipped } = collectCLIMethods(model, pkg)

	const hasEmbeddedSDK = !options.sdkModulePath
	const files: Record<string, string> = {}

	/* runtime templates → internal/cli/ */
	for (const [name, content] of loadGoCliRuntimeTemplates()) {
		files[`internal/cli/${name}`] = content
	}

	files["main.go"] = emitMainFile(options)

	const sortedGroups = [...groups.values()].sort((a, b) => cmpCodeUnit(a.resource, b.resource))
	files["cmd/root.go"] = emitRootFile(sortedGroups, options, detectAuthScheme(spec))

	for (const g of sortedGroups) {
		files[`cmd/${g.fileName}`] = emitResourceFile(g, options)
	}

	files["go.mod"] = emitGoMod(options, hasEmbeddedSDK)
	files["README.md"] = emitReadme(spec, options)

	if (hasEmbeddedSDK) copyEmbeddedSDK(spec, options, files)
	emitSSEExportShim(files, hasEmbeddedSDK)

	return { files, serviceMap: serviceMap as Record<string, Record<string, unknown>>, skippedOperations: skipped }
}
