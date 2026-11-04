/**
 * The MCP registry's `server.json` (plan 39 8.8), written beside package.json when the server has an `mcpName`:
 * `mcp-publisher publish` reads it from the package's root, and the registry checks package.json's `mcpName` against
 * its `name`. Its fields are the 2025-12-11 schema's: the name, a description of 100 characters at most (the run's,
 * else the package's own), the version npm publishes, and the one npm package over stdio with every environment
 * variable the server reads there. The home page is its `websiteUrl`; a GitHub or GitLab repository its `repository`.
 * No `remotes`: where a server is hosted is a deployment's, not the spec's.
 */
import type { IR } from "../../ir/model.ts"
import type { Metadata } from "../shared/metadata.ts"

/** The schema the file names, the registry's latest dated one. */
export const SERVER_SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"

/* the registry's cap on a description, in characters */
const DESCRIPTION_MAX = 100

/* the forges the registry knows by host: the `source` it validates a repository through */
const SOURCES: Readonly<Record<string, string>> = { "github.com": "github", "gitlab.com": "gitlab" }

/** The server as the registry lists it: its names, the version npm publishes, and what its environment holds. */
export type Listing = {
	readonly name: string
	readonly mcpName: string
	readonly packageName: string
	readonly version: string
	readonly envPrefix: string
	readonly files: boolean
}

/** One environment variable as the registry's `KeyValueInput` describes it. */
type Variable = {
	readonly name: string
	readonly description: string
	readonly isRequired?: boolean
	readonly isSecret?: boolean
	readonly default?: string
	readonly format?: "filepath" | "number"
	readonly choices?: readonly string[]
}

/** Every variable the server reads over stdio, as its entry reads them; the HTTP transport's are not the package's. */
function variablesOf(listing: Listing, ir: IR): Variable[] {
	const prefix = listing.envPrefix
	const server = ir.servers[0]
	const sent = `${ir.auth.headerName}: ${ir.auth.prefix}<key>`
	return [
		{ description: `The API key, sent as ${sent}`, isSecret: true, name: `${prefix}_API_KEY` },
		{
			description: "The API's base URL",
			name: `${prefix}_BASE_URL`,
			...(server === undefined ? { isRequired: true } : { default: server }),
		},
		{ default: "30000", description: "A call's limit in milliseconds", format: "number", name: `${prefix}_TIMEOUT_MS` },
		{ description: "A JSON object of headers sent on every call", isSecret: true, name: `${prefix}_HEADERS` },
		{
			choices: ["same-origin", "follow"],
			default: "same-origin",
			description: "Whether a call follows a redirect to another origin",
			name: `${prefix}_REDIRECT`,
		},
		...(listing.files
			? [
					{
						description: "The directory a tool reads files from",
						format: "filepath",
						name: `${prefix}_FILE_ROOT`,
					} as const,
					{
						default: "1048576",
						description: "The most bytes of a file sent inline",
						format: "number",
						name: `${prefix}_MAX_INLINE_BYTES`,
					} as const,
					{
						default: "52428800",
						description: "The most bytes of a file a tool reads",
						format: "number",
						name: `${prefix}_MAX_FILE_BYTES`,
					} as const,
				]
			: []),
	]
}

/** The description the registry shows: the run's, else the package's own, refused past the registry's cap. */
function descriptionOf(listing: Listing, metadata: Metadata): string {
	const text = metadata.description ?? `The ${listing.name} API as MCP tools`
	if ([...text].length > DESCRIPTION_MAX)
		throw new Error(
			`Invalid metadata.description: ${JSON.stringify(text)}: the MCP registry takes ${DESCRIPTION_MAX} characters at most`,
		)
	return text
}

/** The repository as the registry links it, for a forge it knows; none for another host. */
function repositoryOf(repository: string | undefined) {
	if (repository === undefined) return {}
	const source = SOURCES[new URL(repository).hostname]
	return source === undefined ? {} : { repository: { source, url: repository.replace(/\.git$/, "") } }
}

/** server.json for `listing`, from the run's `metadata` and the API's `ir`. */
export function serverJson(listing: Listing, ir: IR, metadata: Metadata): string {
	const npm = {
		environmentVariables: variablesOf(listing, ir),
		identifier: listing.packageName,
		registryType: "npm",
		transport: { type: "stdio" },
		version: listing.version,
	}
	const server = {
		$schema: SERVER_SCHEMA,
		name: listing.mcpName,
		description: descriptionOf(listing, metadata),
		version: listing.version,
		...(metadata.homepage === undefined ? {} : { websiteUrl: metadata.homepage }),
		...repositoryOf(metadata.repository),
		packages: [npm],
	}
	return `${JSON.stringify(server, null, "\t")}\n`
}
