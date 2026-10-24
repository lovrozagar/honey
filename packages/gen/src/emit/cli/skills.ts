/**
 * The agent skill (bit 17 phase e, E1): `skills/<bin>/SKILL.md` in the Agent Skills format, its frontmatter's name
 * the binary's and its description one line. The body is what an agent needs to drive the CLI and nothing past it:
 * discovery, the settings and their target, calling, output, streams when the API has any, errors and exit codes.
 * The module ships the file, and main.go embeds it, so `<bin> skill` prints the same bytes.
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import { helpText } from "./flags.ts"

/** The longest API title the description carries, in characters, `…` included. */
const TITLE_MAX = 200

/** Where the skill lives in the module. */
export const skillPath = (binaryName: string) => `skills/${binaryName}/SKILL.md`

/** The streams an API's commands use, in a fixed order. */
const streamsOf = (ops: readonly SdkOp[]) =>
	(["sse", "ws", "realtime"] as const).filter((kind) => ops.some((op) => op.stream === kind))

/** SKILL.md for the CLI `bin` over the API `title` and its operations, its env variables prefixed `prefix`. */
export function skillFile(bin: string, title: string, prefix: string, ops: readonly SdkOp[]): string {
	const named = [...(helpText(title).replace(/\s+/g, " ").trim() || bin)]
	/* the description stays within the format's 1024 characters whatever the title */
	const api = named.length <= TITLE_MAX ? named.join("") : `${named.slice(0, TITLE_MAX - 1).join("")}…`
	const description = `Call the ${api} API from the shell with ${bin}: find a command, read its request and answer, call it, and branch on its JSON output and exit code.`
	const streams = streamsOf(ops)
	const streaming =
		streams.length === 0
			? []
			: [
					"",
					"## Streams",
					`A stream command (${streams.join(", ")}) prints one JSON line per event; \`--take N\` ends it after N.`,
					...(streams.includes("ws") ? ["A ws command sends each stdin line as a text frame."] : []),
					...(streams.includes("realtime")
						? [
								"A realtime feed writes its resume cursor to stderr when it ends; pass it back with `--reconnect-token` and `--last-event-id`.",
							]
						: []),
				]
	return [
		"---",
		`name: ${bin}`,
		/* a JSON string is a YAML double-quoted scalar: a colon or quote in the title cannot end it */
		`description: ${JSON.stringify(description)}`,
		"---",
		"",
		`# ${bin}`,
		"",
		"## Find a command",
		`- \`${bin} commands\` lists every command, one usage line each: \`<path> <arg> --flag kind [--optional a|b] [--data json] (stream) # summary\`.`,
		`- \`${bin} commands search <words>\` prints the 5 best matches.`,
		`- \`${bin} schema <command>\` prints its method and path, its \`--data\` body, its answer (\`returns\`) or \`events\`, and its error statuses with their keys.`,
		"",
		"## Before a call",
		`Run \`${bin} config\` before a call that changes data: it prints each setting with its source and \`target local|remote <host>\`.`,
		`Settings come from a flag, else \`$${prefix}_<NAME>\`, else \`~/.config/${bin}/config.toml\`: \`--base-url\`, \`--api-key\`, \`--timeout\`, \`--header "Name: value"\`.`,
		"",
		"## Call",
		"- `<arg>` is positional; `--data` takes JSON, `@file`, or `-` for stdin.",
		"- Piped output is one line of compact JSON; `--format yaml|table|ndjson`, `-o <file>`, `-i` adds the status and headers.",
		'- An error is one JSON line on stderr: `{"error":{"kind","status","errorKey","message"}}`.',
		...streaming,
		"",
		"## Exit codes",
		"0 ok, 1 a 4xx or other failure, 2 a 5xx, 3 no answer (transport, timeout, a dropped stream), 4 a usage error, 5 a redirect not followed, 130 interrupted.",
		"",
	].join("\n")
}
