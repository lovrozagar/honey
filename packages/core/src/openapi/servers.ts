/**
 * The document's servers. With no list, the stripped prefix is the one server (a client sends it,
 * the app strips it). A caller's list replaces that default, the prefix appended to each URL;
 * basePath is in the paths already. A server that cannot be served is refused: each `{var}` is
 * declared and each declared variable used, a default is in its enum, a name is a plain word, and
 * no text holds a stray control character (a URL or description lands verbatim in docs pages and SDKs).
 */

export type OpenApiServerVariable = {
	readonly default: string
	readonly description?: string
	readonly enum?: readonly string[]
}

export type OpenApiServer = {
	readonly description?: string
	readonly url: string
	readonly variables?: Readonly<Record<string, OpenApiServerVariable>>
}

/* C0, DEL and C1 */
const CONTROL = /\p{Cc}/u
/* a description is CommonMark: tabs and line breaks are its own */
const STRAY = /(?![\t\n\r])\p{Cc}/u
const NAME = /^[A-Za-z0-9_]+$/
const VARIABLE = /\{([^{}]*)\}/g

/** `url` with `prefix` after it, one slash between them. */
const prefixed = (url: string, prefix: string | null) => (prefix === null ? url : `${url.replace(/\/+$/, "")}${prefix}`)

/** Each reason `variable` cannot be served. */
function variableErrors(name: string, variable: OpenApiServerVariable): string[] {
	const errors: string[] = []
	if (!NAME.test(name)) errors.push("a name is letters, digits and _ only")
	if (CONTROL.test(variable.default)) errors.push("its default holds a control character")
	if (variable.description !== undefined && STRAY.test(variable.description))
		errors.push("its description holds a control character")
	const values = variable.enum
	if (values?.length === 0) errors.push("an enum must list at least one value")
	else if (values !== undefined && !values.includes(variable.default))
		errors.push(`default "${variable.default}" is not in its enum`)
	if (values?.some((value) => CONTROL.test(value))) errors.push("its enum holds a control character")
	return errors.map((reason) => `variable "${name}": ${reason}`)
}

/** Each reason `server` cannot be served. */
function serverErrors(server: OpenApiServer): string[] {
	const errors: string[] = []
	if (CONTROL.test(server.url)) errors.push("the URL holds a control character")
	if (server.description !== undefined && STRAY.test(server.description))
		errors.push("the description holds a control character")
	if (/[{}]/.test(server.url.replaceAll(VARIABLE, ""))) errors.push("the URL has an unmatched brace")
	const used = new Set([...server.url.matchAll(VARIABLE)].map((match) => match[1] as string))
	const variables = server.variables ?? {}
	for (const name of used) {
		if (!Object.hasOwn(variables, name)) errors.push(`{${name}} is not declared in variables`)
	}
	for (const [name, variable] of Object.entries(variables)) {
		if (!used.has(name)) errors.push(`variable "${name}" is declared but not used in the URL`)
		errors.push(...variableErrors(name, variable))
	}
	return errors
}

/** The servers the document lists, each refusal reported through `error`. */
export function serversOf(
	servers: readonly OpenApiServer[] | undefined,
	stripPrefix: string | null,
	error: (message: string) => void,
): OpenApiServer[] {
	if (servers === undefined) return stripPrefix === null ? [] : [{ url: stripPrefix }]
	return servers.map((server, i) => {
		for (const reason of serverErrors(server)) error(`server ${i + 1} (${JSON.stringify(server.url)}): ${reason}`)
		const out: { description?: string; url: string; variables?: Record<string, OpenApiServerVariable> } = {
			url: prefixed(server.url, stripPrefix),
		}
		if (server.description !== undefined) out.description = server.description
		if (server.variables !== undefined)
			out.variables = structuredClone(server.variables) as Record<string, OpenApiServerVariable>
		return out
	})
}
