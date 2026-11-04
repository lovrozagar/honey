/**
 * What 0.7.3 exported and 1.0 does not, and where a reader learns it (bit 22 a). The guide is judged against the
 * `v0.7.3` tag the way no-old-names is, and from a baseline pinned in blueprint/baselines/v073-exports.json rather
 * than read from the tag at test time: a CI checkout need not carry tags, and the tag is immutable, so the pinned
 * table is the same answer offline. It was written with
 * `git show v0.7.3:packages/core/package.json` and each subpath's source at that tag.
 *
 * Why a table and not "name them all": 0.7.3 exported 369 names, a third of them its own internals (an adapter's
 * `WSContextImpl`, the plugin's `ResolvedHoneyConfig`, the tree's `matchRoute`), and naming those in the guide
 * would bury the breaks a reader can act on. So each removed name is judged once: `guide` (a name a consumer
 * wrote, which migration.md must name) or `internal` (never a name to write, with the reason). A removal nobody
 * judged reds here, which is what the `LoggerInstance`/`logger` class of miss needed.
 */

/**
 * A removed subpath: the whole module is gone, and `covers` is the words of the guide a reader goes to. `null`
 * where the guide must not name it — one adapter's runtime is gone from v1 and the repo forbids its name outside
 * history (tests/structure/no-deno.test.ts) — and `why` then says so.
 */
export type RemovedSubpath = {
	readonly covers: string | null
	readonly subpath: string
	readonly why?: string
}

/** What a removed name is: a name the guide must carry, or an internal with the reason it never was one. */
export type Verdict = { readonly kind: "guide" } | { readonly kind: "internal"; readonly why: string }

/**
 * Every subpath 0.7.3 exported that 1.0 does not, with the words of the guide that cover it. A name under one of
 * these is judged by its subpath, not one by one: the subpath's own section is where the reader goes.
 */
export const REMOVED_SUBPATHS: readonly RemovedSubpath[] = [
	{ covers: "honey-clients generate", subpath: "./cli" },
	{ covers: "client.safe", subpath: "./client" },
	{ covers: "client.safe", subpath: "./client/sdk" },
	{ covers: "@lovrozagar/honey-clients", subpath: "./codegen" },
	{ covers: "@lovrozagar/honey-clients", subpath: "./codegen-go-cli" },
	{ covers: "@lovrozagar/honey-clients", subpath: "./codegen/extract" },
	{ covers: "serveOpenApi", subpath: "./openapi/spec" },
	{ covers: "@lovrozagar/honey/node", subpath: "./serve" },
	{ covers: "trustProxy", subpath: "./trust" },
	{ covers: "workersWebSocket", subpath: "./ws/cloudflare" },
	{
		covers: null,
		subpath: "./ws/deno",
		why: "its runtime is gone from v1 and no file outside history names it, the guide included",
	},
]

/* why a name was never one to write: the same reason reads for a whole family */
const ADAPTER = "a WebSocket adapter's own plumbing, reached through ws() and the adapter, never imported"
const PLUGIN = "the plugin's resolved config and write path, read by the plugin itself"
const TREE = "the matcher behind a route tree; a consumer names RouteTree and TreeNode, which 1.0 keeps"
const SHAPE = "an internal shape of the route builder's types, never written in an app"

/**
 * Each name a kept subpath exported at 0.7.3 and no longer does. `guide` means migration.md names it: those are
 * the enablers and types a 0.7.3 app wrote (`logger()` in a `.use()`, `detectRuntime()`, `trustProxy`'s types).
 */
export const REMOVED_NAMES: Readonly<Record<string, Verdict>> = {
	ClientInfo: { kind: "guide" },
	DefaultMeta: { kind: "guide" },
	GenerateOptions: { kind: "internal", why: PLUGIN },
	HoneyGoCliConfig: { kind: "internal", why: PLUGIN },
	HoneySdkPortsConfig: { kind: "internal", why: PLUGIN },
	HoneyServeOptions: { kind: "guide" },
	HoneyServer: { kind: "guide" },
	HttpMethod: { kind: "internal", why: TREE },
	InputSchemasDef: { kind: "internal", why: SHAPE },
	InvalidateCheckConfig: { kind: "internal", why: PLUGIN },
	InvalidateCheckLevel: { kind: "internal", why: PLUGIN },
	LogData: { kind: "guide" },
	LoggerInstance: { kind: "guide" },
	LoggerOptions: { kind: "guide" },
	MatchResult: { kind: "internal", why: TREE },
	MetaSpecTarget: { kind: "internal", why: SHAPE },
	NodeUpgradeData: { kind: "internal", why: ADAPTER },
	OpenApiMeta: { kind: "guide" },
	OutputSchemaDef: { kind: "internal", why: SHAPE },
	OutputValidator: { kind: "internal", why: TREE },
	Overwrite: { kind: "internal", why: SHAPE },
	PendingTap: { kind: "internal", why: "the tap queue's own entry, filled by tap() and read by the dispatcher" },
	RawSocket: { kind: "internal", why: ADAPTER },
	RealtimeRouteOpts: { kind: "guide" },
	ResolvedGoCliConfig: { kind: "internal", why: PLUGIN },
	ResolvedHoneyConfig: { kind: "internal", why: PLUGIN },
	ResolvedInvalidateCheck: { kind: "internal", why: PLUGIN },
	ResolvedOpenApiOutput: { kind: "internal", why: PLUGIN },
	ResolvedSdkPorts: { kind: "internal", why: PLUGIN },
	RouteHandler: { kind: "internal", why: TREE },
	RouteId: { kind: "internal", why: TREE },
	SignOptions: { kind: "guide" },
	ServeRuntime: {
		kind: "internal",
		why: "the runtime name the request log records; a server imports its runtime's serve, so an app never names one",
	},
	SuccessStatusKey: { kind: "internal", why: SHAPE },
	TranslationRegistry: {
		kind: "internal",
		why: "the i18n registry core fills; an app passes createErrorTranslator() instead",
	},
	TrustProxy: { kind: "guide" },
	VerifyOptions: { kind: "guide" },
	WSContextImpl: { kind: "internal", why: ADAPTER },
	WSPreUpgrade: { kind: "internal", why: ADAPTER },
	WSRouteHandler: { kind: "internal", why: TREE },
	clientInfo: { kind: "guide" },
	detectRuntime: { kind: "guide" },
	createProxyHandler: { kind: "guide" },
	defineMiddleware: { kind: "guide" },
	enableI18n: { kind: "guide" },
	enableOpenApi: { kind: "guide" },
	generateAndWrite: { kind: "internal", why: PLUGIN },
	generateFromApp: { kind: "internal", why: PLUGIN },
	generateRouteTree: { kind: "internal", why: PLUGIN },
	generatedOutputs: { kind: "internal", why: PLUGIN },
	getLastHoneyConfig: { kind: "internal", why: PLUGIN },
	isGeneratedOutput: { kind: "internal", why: PLUGIN },
	logger: { kind: "guide" },
	matchRoute: { kind: "internal", why: TREE },
	matchWsRoute: { kind: "internal", why: TREE },
	mergeInto: { kind: "internal", why: TREE },
	overlaySchemas: { kind: "internal", why: TREE },
	resolveFieldName: {
		kind: "internal",
		why: "the i18n lookup core calls; an app passes createErrorTranslator() instead",
	},
	resolveHoneyConfig: { kind: "internal", why: PLUGIN },
	resolveTranslation: {
		kind: "internal",
		why: "the i18n lookup core calls; an app passes createErrorTranslator() instead",
	},
	sign: { kind: "guide" },
	spec: { kind: "guide" },
	verify: { kind: "guide" },
}

/** The names a module's source exports, however it writes them: a list, a re-export, or a declaration. */
export function exportedNames(source: string): Set<string> {
	const names = new Set<string>()
	for (const match of source.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
		for (const part of (match[1] as string).split(",")) {
			const named = part.trim().replace(/^type\s+/, "")
			const name = (named.includes(" as ") ? named.split(" as ")[1] : named)?.trim()
			if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
		}
	}
	const declared =
		/^export (?:declare )?(?:const|let|var|function|async function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm
	for (const match of source.matchAll(declared)) names.add(match[1] as string)
	return names
}

/** Every name the subpaths of `sources` export, by subpath. */
export function surfaceOf(sources: Readonly<Record<string, string>>): Record<string, Set<string>> {
	return Object.fromEntries(Object.entries(sources).map(([subpath, text]) => [subpath, exportedNames(text)]))
}

/**
 * What 0.7.3 exported that `now` does not: each kept subpath's lost names, and the subpaths that went with
 * everything in them.
 */
export function removed(
	old: Readonly<Record<string, readonly string[]>>,
	now: Readonly<Record<string, Set<string>>>,
): { readonly names: string[]; readonly subpaths: string[] } {
	const live = new Set(Object.values(now).flatMap((names) => [...names]))
	const subpaths = Object.keys(old)
		.filter((subpath) => !Object.hasOwn(now, subpath))
		.sort()
	const names = [
		...new Set(
			Object.entries(old)
				.filter(([subpath]) => Object.hasOwn(now, subpath))
				.flatMap(([, names]) => names.filter((name) => !live.has(name))),
		),
	].sort()
	return { names, subpaths }
}
