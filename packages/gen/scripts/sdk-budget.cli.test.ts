/**
 * The generated CLI's budgets (bit 17): the vendored CLI runtime's bytes on disk (the G14 analog), locked at the close;
 * the tokens an agent reads from each e2e app's built binary (H6, G13: the CLI's own ceilings, read from what the
 * binary prints); and the kitchen CLI's stripped static binary, linked as a release links it.
 */
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { toIR, type OpenApiDocument } from "../src/ir/build.ts"
import { sdkModel } from "../src/ir/sdk-model.ts"
import { builtCli, linkSettings } from "../src/emit/cli/__fixtures__/built.ts"
import { commandTree } from "../src/emit/cli/commands.ts"
import { discoveryEntries } from "../src/emit/cli/discovery.ts"
import { CLI_RUNTIME, generateGoCli } from "../src/emit/cli/module.ts"
import { goCacheDir, runGo, withGo } from "../src/emit/go/__fixtures__/go-env.ts"
import { goCallPlans } from "../src/emit/go/sdk.ts"
import { ceilingOf, countTokens } from "./capture-token-budget.ts"
import { runtimeBytes } from "./sdk-budget.ts"
import { SPAWN_TIMEOUT } from "../src/gen/__fixtures__/spawn-timeout.ts"

const GO = withGo()
const SLOW = { timeout: 600_000 }
const REPO = resolve(import.meta.dirname, "../../..")

/*
 * G14 analog (bit 17), locked at phase i at the exact measured bytes (zero headroom, as Java's 149,981), over every
 * runtime file:
 * - phase a, 2,562 B: run.go, the root command's shape (--version alone, no default completion, an unknown command
 *   or flag a usage error), the run that maps an outcome to its exit code, and the version a release links in;
 *   provisional 2,600.
 * - phase b, +19,431 B to 21,993 B, nothing dead to cut (every member is reached by an emitted command or the global
 *   flags):
 *   - config.go 5,955: the global flags, each setting from its flag, its environment variable or the TOML config file
 *     (found by --config, $<PREFIX>_CONFIG, XDG or HOME, an unknown key refused), the readable-key warning;
 *   - params.go 5,168: the parameter flags, each checked against its kind and enum as given, the help naming the enum
 *     and a required flag; the path parameters, positional or flagged; Set, a flag's values into an Opts field's type;
 *   - body.go 3,869: --data (as given, @file, standard input), the JSON body with each body flag over its key, the
 *     text, form and streamed binary bodies;
 *   - run.go +1,626 to 4,188: the exit codes by outcome (4xx, 5xx, no answer, usage, redirect, interrupt), APIError,
 *     the App the root is named by, Ctrl-C cancelling the call;
 *   - log.go 2,197: --verbose, the request and response on stderr with every credential header and secret redacted;
 *   - output.go 616: an answer as one line of compact JSON (bytes and text as they came);
 *   provisional 22,000.
 * - phase c, +13,970 B to 35,963 B, after cutting a second error classification and a duplicated render path (214 B):
 *   - output.go +6,158 to 6,774: --format json/ndjson/yaml/table, --json, table the default on a terminal, -i (status
 *     and the declared headers), --raw, -o, a binary answer refused on a terminal or under -i, compact JSON with DEL
 *     and C1 escaped, control characters escaped on a terminal;
 *   - format.go 4,604: the YAML writer (keys and scalars quoted where a reader would misread them) and the table
 *     (a column per key over a list of objects, a key and value per row for an object, nested values as JSON);
 *   - run.go +1,361 to 5,549: an error on stderr as one JSON line by kind, status and key, else after the name with
 *     its controls escaped; one classification feeding both the kind and the exit code;
 *   - body.go +962 to 4,831: the multipart file parts, a file or standard input per part, repeatable;
 *   - log.go +885 to 3,082: each secret also as the SDK percent-encodes it into a path and a query;
 *   provisional 36,000.
 * - phase d, +7,690 B to 43,653 B, after cutting Closed's Unwrap (kindOf takes any close as transport):
 *   - stream.go 5,802: a stream's output (one line per event, a YAML document each, ndjson for a table, -o, --take,
 *     -i and --raw refused), the SSE event line, a message's bytes as JSON, a string or base64, the realtime feed
 *     followed to its end with its cursor on stderr, --max-reconnects, Closed (an abnormal close, a transport failure);
 *   - socket.go 1,738, shipped only beside the WebSocket library: stdin lines as text frames, each message printed, a
 *     close frame on --take and on Ctrl-C, the close code as the outcome;
 *   - run.go +150 to 5,699: Ctrl-C ending a stream with no error still exits 130; Closed classed as transport;
 *   provisional 43,700.
 * - phase e, +10,024 B to 53,677 B, after reusing sortedKeys for config's headers and cutting a second redaction of
 *   credential headers (redact already holds their values), 156 B:
 *   - discovery.go 4,339: `commands` (the local line, a usage line per command, --json one object each), `commands
 *     search` (shared words, ties in path order, 5 at most), `schema` and its JSON, `skill`;
 *   - target.go 3,292: the target (loopback local, else remote, by host), the terminal-only target line under -q,
 *     `config` (each setting with its source, secrets redacted, as text or one JSON object);
 *   - config.go +1,321 to 7,276: each setting's source, --quiet ($<PREFIX>_QUIET, the file's quiet), the API's server;
 *   - run.go +919 to 6,618: the App's server, discovery and skill; the API and local help groups, the two-line banner;
 *   - params.go +153 to 5,321: an enum flag's values completing;
 *   provisional 53,700.
 * - phase f, +1,642 B to 55,319 B, nothing dead to cut (each line serves the redirect setting or its hint):
 *   - config.go +994 to 8,270: --redirect same-origin|follow ($<PREFIX>_REDIRECT, the file's redirect), an unknown
 *     value a usage error, and the setting read again where an error is reported;
 *   - run.go +624 to 7,242: a redirect not followed names the way out (rerun with --redirect follow);
 *   - target.go +24 to 3,316: `config` shows the redirect policy with its source;
 *   provisional 55,400.
 * - phases g and h, no runtime change (the release files, the install scripts and the generate CLI are the emitter's
 *   and the package's).
 * - phase i, +37 B to 55,356 B: run.go classes a body cut short (io.ErrUnexpectedEOF, an event stream dropped mid-way)
 *   as a transport failure, exit 3, not 1 (the v0 cases' recheck found it). The lock: nothing dead to cut, so the
 *   ceiling is the measured 55,356 B, provisional 55,400 → locked 55,356.
 * - bit 19 e, +199 B to 55,555 B: log.go's secretsOf redacts a realtime dial's reconnect_token and last_event_id query
 *   values and its Last-Event-ID header (+164), +35 of comments.
 * A change raises it only by the bytes of a named feature, dead code cut first.
 */
const CLI_RUNTIME_BYTES = 55555

describe("the CLI runtime within its byte budget (bit 17, the G14 analog)", () => {
	it(
		`ships every runtime file it holds, their bytes exactly ${CLI_RUNTIME_BYTES}, nothing else beside them`,
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const { bytes, names, others } = runtimeBytes(resolve(import.meta.dirname, "../src/runtime/cli"), ".go")
			expect({ bytes, names, others }).toEqual({
				bytes: CLI_RUNTIME_BYTES,
				names: [...CLI_RUNTIME].sort(),
				others: [],
			})
		},
	)
})

/** What an agent reads of a CLI, in o200k tokens: each surface's largest, as the binary prints it. */
type Surfaces = {
	/** `<bin> commands`, the whole index */
	readonly index: number
	/** the largest index line: one command's usage */
	readonly command: number
	/** the largest `<bin> schema <command>` */
	readonly schema: number
	/** the root help's two-line banner */
	readonly banner: number
	/** `<bin> skill`, SKILL.md */
	readonly skill: number
}

/*
 * H6, G13 (bit 17 phase i): the CLI's own ceilings, each app's own, at ceilingOf(measured, 0.2). Measured from each e2e
 * app's built binary (cobra assembles help at run time, so the binary's output is the shipped text); each app's index
 * is the emitter's line for line, and holds a command per call plan. The medians beside each max: per command 7, 4, 7,
 * 7 and 7; schema 37, 11, 17, 24 and 34 (compose, defaults, gateway, kitchen, surface). The local line is 8 tokens of
 * each index. The banner and the skill are fixed overhead, once per CLI. A surface over its ceiling is fixed in the
 * emitter or the schema, never by raising the ceiling; a raise names the feature that adds the tokens. Bit 19 j1:
 * kitchen's document is v1's, /api/generated-tree retired and carry-in #7's two stream commands added: its index
 * 175 -> 176 and its skill 441 -> 444; every other surface and app unchanged.
 */
const MEASURED: Readonly<Record<string, Surfaces>> = {
	compose: { banner: 41, command: 10, index: 59, schema: 50, skill: 384 },
	defaults: { banner: 44, command: 7, index: 22, schema: 16, skill: 392 },
	gateway: { banner: 44, command: 15, index: 61, schema: 45, skill: 392 },
	kitchen: { banner: 47, command: 15, index: 176, schema: 46, skill: 444 },
	surface: { banner: 44, command: 26, index: 274, schema: 66, skill: 433 },
}
const TOKEN_HEADROOM = 0.2

/** An e2e app's emitted OpenAPI document. */
const appSpec = (app: string) =>
	JSON.parse(
		readFileSync(join(REPO, `packages/core/tests/e2e/apps/${app}/src/_gen/openapi.gen.json`), "utf8"),
	) as Record<string, unknown>

/** `app`'s CLI built, and what its binary prints of each surface, beside what the emitter planned. */
async function surfacesOf(app: string) {
	const document = appSpec(app)
	const model = sdkModel(toIR(document as OpenApiDocument, { deriveOperationIds: true }))
	const plans = goCallPlans(document)
	const entries = discoveryEntries(commandTree(model.ops, plans), model)
	const cli = builtCli(generateGoCli(document).files)
	const text = async (args: readonly string[]) => (await cli.cli(args)).stdout
	const lines = (await text(["commands"])).split("\n").filter((line) => line !== "" && !line.startsWith("local:"))
	const schemas = await Promise.all(entries.map((entry) => text(["schema", ...entry.path.split(" ")])))
	const help = (await text(["--help"])).split("\n")
	const at = help.findIndex((line) => line.startsWith("Agents: "))
	const measured: Surfaces = {
		banner: at < 0 ? 0 : countTokens(`${help[at]}\n${help[at + 1]}\n`),
		command: Math.max(...lines.map((line) => countTokens(`${line}\n`))),
		index: countTokens(await text(["commands"])),
		schema: Math.max(...schemas.map(countTokens)),
		skill: countTokens(await text(["skill"])),
	}
	return { emitted: entries.map((entry) => entry.line), lines, measured, plans: Object.keys(plans).length }
}

describe.skipIf(!GO)("the CLI's tokens within each app's ceilings (bit 17 phase i, H6)", SLOW, () => {
	it.each(Object.keys(MEASURED))(
		"keeps %s's index, each command, each schema, the banner and the skill within ceilingOf(measured, 0.2)",
		async (app) => {
			const { emitted, lines, measured, plans } = await surfacesOf(app)
			const pinned = MEASURED[app] as Surfaces
			const ceilings = Object.fromEntries(
				Object.entries(pinned).map(([surface, tokens]) => [surface, ceilingOf([tokens], TOKEN_HEADROOM)]),
			)
			/* completeness: every command measured, so none can pass by going unread */
			expect({ commands: lines.length, emitted: lines, plans }).toEqual({ commands: plans, emitted, plans })
			expect(
				Object.entries(measured).filter(([surface, tokens]) => tokens > (ceilings[surface] as number) || tokens === 0),
			).toEqual([])
		},
	)
})

/*
 * The static binary stays small (bits/12:26; Q12): the kitchen CLI linked as a release links it (CGO_ENABLED=0,
 * -trimpath, -s -w, the version stamped) for linux/amd64 under the pinned Go, measured 9,932,960 B, ceiling
 * ceilingOf(measured, 0.02). A raise names its cause (a new module dependency, a Go release, a runtime feature).
 * Bit 19 j1: 9,953,440 B (+20,480 B), carry-in #7's two stream commands (/api/events, /api/events-live) in the
 * cutover's v1-generated kitchen document.
 */
const KITCHEN_STRIPPED = 9953440
const SIZE_HEADROOM = 0.02

describe.skipIf(!GO)("the CLI binary within its size (bit 17 phase i)", SLOW, () => {
	it(`links the kitchen CLI for linux/amd64 within ceilingOf(${KITCHEN_STRIPPED}, ${SIZE_HEADROOM}) bytes`, () => {
		const files = generateGoCli(appSpec("kitchen")).files
		const cli = builtCli(files)
		const modulePath = /^module (\S+)$/m.exec(files["go.mod"] ?? "")?.[1] ?? ""
		const { env, flags } = linkSettings(modulePath)
		const out = join(mkdtempSync(join(goCacheDir("tmp"), "size-")), "kitchen")
		const link = runGo(["build", ...flags, "-o", out, "."], {
			cwd: cli.dir,
			env: { ...env, GOARCH: "amd64", GOOS: "linux" },
		})
		expect([link.status, link.stderr]).toEqual([0, ""])
		expect(statSync(out).size).toBeLessThanOrEqual(ceilingOf([KITCHEN_STRIPPED], SIZE_HEADROOM))
	})
})
