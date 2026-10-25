/**
 * The CLI target of the conformance grid (bit 17 phase f, E1): every `cellsFor("cli")` cell through the CLI
 * `generateGoCli` emits from the spawned reference app's served document, built once per content hash and run as one
 * process per call. A call is its command (the operation's path in the command tree), its parameters as positionals
 * and flags by their claimed names, its body as --data (bytes from a file), and --header, --base-url, --timeout,
 * --raw, --last-event-id, --reconnect-token and --take; the setup reaches it as the environment and the config file
 * (the bearer as $CONFORMANCE_API_KEY, headers and a header credential in the file's [headers], the timeout and the
 * redirect policy as variables), so precedence is exercised too. The observation is read from -i's
 * {status, headers, data}, --raw's response, an -o file's bytes (its status from --verbose), the stream lines, or the
 * stderr envelope. A CLI-only row runs its `argv` as given and observes the exit code, stdout and stderr.
 *
 * The two-call overrides cells map to two processes: "the client default untouched" is the second call, made with no
 * override, seeing the setup's default apply. A CLI has no client shared across calls, so this is the whole claim.
 * Opt-in: `vitest run --mode harness`.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { toIR, type OpenApiDocument } from "../../../src/ir/build.ts"
import { sdkModel, type SdkOp } from "../../../src/ir/sdk-model.ts"
import { builtCli } from "../../../src/emit/cli/__fixtures__/built.ts"
import { commandTree, type CommandNode } from "../../../src/emit/cli/commands.ts"
import { commandFlags, type Usage } from "../../../src/emit/cli/flags.ts"
import { generateGoCli } from "../../../src/emit/cli/module.ts"
import { GO_FLOOR, goCacheDir, withGo } from "../../../src/emit/go/__fixtures__/go-env.ts"
import { goCallPlans } from "../../../src/emit/go/sdk.ts"
import { type ReferenceApp, type TargetRunner, targetSuite } from "./harness.ts"
import { type Call, type Cell, cellsFor, type Json, type Observed, type Setup } from "./matrix.ts"

/** The reference app's CLI: its title gives the binary and the variables' prefix. */
const PREFIX = "CONFORMANCE"

type Built = ReturnType<typeof builtCli>
/** One command: its path in the tree, its arguments as discovery shows them, its operation. */
type Command = { readonly op: SdkOp; readonly path: readonly string[]; readonly usage: readonly Usage[] }

/** Every leaf command by its operation id. */
function commandsOf(document: Record<string, unknown>): Map<string, Command> {
	const ir = toIR(document as OpenApiDocument, { deriveOperationIds: true })
	const model = sdkModel(ir)
	const out = new Map<string, Command>()
	const walk = (nodes: readonly CommandNode[], at: readonly string[]) => {
		for (const node of nodes) {
			const path = [...at, node.name]
			if (node.op !== undefined) {
				const { usage } = commandFlags(node.op.op, node.op.plan, ir.schemas)
				out.set(node.op.op.id, { op: node.op.op, path, usage })
			}
			walk(node.children, path)
		}
	}
	walk(commandTree(model.ops, goCallPlans(document)), [])
	return out
}

/** The environment and config file a setup gives every call of its cell. */
function setupEnv(setup: Setup | undefined, app: ReferenceApp, dir: string): Record<string, string> {
	const env: Record<string, string> = { [`${PREFIX}_BASE_URL`]: app.url }
	const headers = { ...setup?.headers }
	if (setup?.auth?.kind === "bearer") env[`${PREFIX}_API_KEY`] = setup.auth.token
	if (setup?.auth?.kind === "header") headers[setup.auth.name] = setup.auth.value
	if (setup?.timeoutMs !== undefined) env[`${PREFIX}_TIMEOUT`] = `${setup.timeoutMs}ms`
	if (setup?.redirect !== undefined) {
		if (setup.redirect === "none") throw new Error("the CLI has no redirect policy `none`")
		env[`${PREFIX}_REDIRECT`] = setup.redirect
	}
	if (Object.keys(headers).length > 0) {
		/* a JSON string is a TOML basic string */
		const lines = Object.entries(headers).map(([name, value]) => `${JSON.stringify(name)} = ${JSON.stringify(value)}`)
		const file = join(dir, "config.toml")
		writeFileSync(file, `[headers]\n${lines.join("\n")}\n`, { mode: 0o600 })
		env[`${PREFIX}_CONFIG`] = file
	}
	return env
}

/** The flag `usage` names for parameter `param` (a header case-insensitively), or none. */
const flagFor = (usage: readonly Usage[], param: string) =>
	usage.find((each) => !each.positional && each.param?.toLowerCase() === param.toLowerCase())

/** A call's parameters as arguments: each path one positional, each query value its flag (a list repeated). */
function paramArgs(call: Call, command: Command): string[] {
	const args: string[] = []
	for (const each of command.usage.filter((u) => u.positional)) {
		const value = call.params?.[each.param ?? ""]
		if (value === undefined) throw new Error(`${call.operation}: no value for the path parameter ${each.param}`)
		args.push(value)
	}
	for (const [name, value] of Object.entries(call.search ?? {})) {
		const flag = flagFor(command.usage, name)
		if (flag === undefined) throw new Error(`${call.operation}: no flag for the query parameter ${name}`)
		for (const each of Array.isArray(value) ? value : [value]) args.push(`--${flag.name}=${String(each)}`)
	}
	for (const [name, value] of Object.entries(call.headers ?? {})) {
		const flag = flagFor(command.usage, name)
		args.push(...(flag === undefined ? ["--header", `${name}: ${value}`] : [`--${flag.name}=${value}`]))
	}
	return args
}

/** A call's body as --data: JSON as given, bytes from a file under `dir`. */
function bodyArgs(call: Call, dir: string): string[] {
	if (call.body?.kind === "json") return ["--data", JSON.stringify(call.body.value)]
	if (call.body?.kind !== "binary") return []
	const file = join(dir, "body.bin")
	writeFileSync(file, Buffer.from(Array.from({ length: call.body.size }, (_, i) => i & 0xff)))
	return ["--data", `@${file}`]
}

/** A call's own flags: its origin, deadline and stream cursors. */
const callFlags = (call: Call, app: ReferenceApp): string[] => [
	...(call.origin === "alt" ? ["--base-url", app.alt] : []),
	...(call.timeoutMs === undefined ? [] : ["--timeout", `${call.timeoutMs}ms`]),
	...(call.lastEventId === undefined ? [] : ["--last-event-id", call.lastEventId]),
	...(call.reconnectToken === undefined ? [] : ["--reconnect-token", call.reconnectToken]),
	...(call.take === undefined ? [] : ["--take", String(call.take)]),
]

/** stdout's lines, the last line's end dropped. */
const linesOf = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"))

/** A stderr line as JSON when it is, else as the string. */
function jsonOr(line: string): Json {
	try {
		return JSON.parse(line) as Json
	} catch {
		return line
	}
}

/** A failed call's observation from its stderr envelope: the API's error by status and key, or a timeout. */
function failure(stderr: string, status: number): Observed {
	const last = linesOf(stderr).at(-1) ?? ""
	const envelope = jsonOr(last) as { error?: { errorKey?: string; kind: string; status?: number } }
	if (envelope.error?.kind === "timeout") return { kind: "timeout" }
	if (envelope.error?.kind === "api" && envelope.error.status !== undefined)
		return { errorKey: envelope.error.errorKey ?? null, kind: "error", status: envelope.error.status }
	throw new Error(`the CLI exited ${status} with no API error or timeout: ${stderr}`)
}

/** An untyped body: JSON when it is, text when it is not, null when empty (Go's driver's rule). */
const untyped = (body: string): Json => (body === "" ? null : jsonOr(body))

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/** What one call runs with: the built CLI, the setup's environment, the app. */
type Run = { readonly app: ReferenceApp; readonly cli: Built; readonly env: Record<string, string> }

/** One call of a shared cell, observed. */
async function observed({ app, cli, env }: Run, call: Call, command: Command): Promise<Observed> {
	const dir = mkdtempSync(join(goCacheDir("tmp"), "cli-call-"))
	const args = [...command.path, ...paramArgs(call, command), ...bodyArgs(call, dir), ...callFlags(call, app)]
	const input = call.send === undefined ? "" : `${call.send.join("\n")}\n`
	const { op } = command
	if (op.stream !== null) {
		const ran = await cli.cli(args, { env, input })
		if (ran.status !== 0) return failure(ran.stderr, ran.status)
		const lines = linesOf(ran.stdout).map((line) => JSON.parse(line) as Json)
		if (op.stream !== "sse") return { frames: lines, kind: "frames" }
		return { events: lines as { data: Json; event?: string; id?: string }[], kind: "events" }
	}
	/* an operation declaring no success body is read untyped through --raw, as Go's driver and TS's runner read it */
	if (call.raw === true || op.success.kind === "none") {
		const ran = await cli.cli([...args, "--raw"], { env, input })
		if (ran.status !== 0) return failure(ran.stderr, ran.status)
		const raw = JSON.parse(ran.stdout) as { body: string; headers: Record<string, string>; status: number }
		if (call.raw === true) return { body: raw.body, headers: raw.headers, kind: "raw", status: raw.status }
		return { data: untyped(raw.body), kind: "data", status: raw.status }
	}
	if (op.success.kind === "binary") {
		const file = join(dir, "answer.bin")
		const ran = await cli.cli([...args, "-o", file, "--verbose"], { env, input })
		if (ran.status !== 0) return failure(ran.stderr, ran.status)
		const status = Number(/^< (\d{3})$/m.exec(ran.stderr)?.[1])
		const bytes = readFileSync(file)
		return { kind: "bytes", sha256: sha256(bytes), size: bytes.length, status } as Observed
	}
	const ran = await cli.cli([...args, "-i"], { env, input })
	if (ran.status !== 0) return failure(ran.stderr, ran.status)
	const answer = JSON.parse(ran.stdout) as { data: Json; headers: Record<string, string>; status: number }
	const headers = Object.keys(answer.headers).length > 0 ? { headers: answer.headers } : {}
	return { data: answer.data ?? null, kind: "data", status: answer.status, ...headers } as Observed
}

/** One call of a CLI-only row: its argv as given, `$FILE` a fresh path read back. */
async function observedArgv(cli: Built, argv: readonly string[], env: Record<string, string>): Promise<Observed> {
	const file = join(mkdtempSync(join(goCacheDir("tmp"), "cli-argv-")), "out")
	const wrote = argv.includes("$FILE")
	const ran = await cli.cli(
		argv.map((arg) => (arg === "$FILE" ? file : arg)),
		{ env },
	)
	const bytes = wrote ? readFileSync(file) : undefined
	return {
		exit: ran.status,
		...(bytes === undefined ? {} : { file: { sha256: sha256(bytes), size: bytes.length } }),
		kind: "cli",
		stderr: linesOf(ran.stderr).map(jsonOr),
		stdout: linesOf(ran.stdout),
	}
}

/**
 * The CLI runner: the reference app's CLI built, vetted and linked once from the served document. A call it cannot
 * express throws, and the cell is red, never skipped.
 */
/** The shared cells the CLI lacks by design, each with its reason. */
const LACKS: Readonly<Record<string, string>> = {
	"json-status/realtime-send-non-ascii":
		"a realtime command only prints its feed (Resume): standard input is sent by a WebSocket command alone (bit 17)",
	"json-status/realtime-send-raw-text":
		"a realtime command only prints its feed (Resume): standard input is sent by a WebSocket command alone (bit 17)",
}

function cliRunner(): TargetRunner {
	let cli: Built | undefined
	let commands = new Map<string, Command>()
	return {
		lacks: (cell) => Object.hasOwn(LACKS, cell.key),
		async prepare(app) {
			const built = builtCli(generateGoCli(app.document).files)
			if (!built.built || built.vet.length > 0 || built.linkErrors !== "")
				throw new Error(`${built.stderr}${built.vet.join("\n")}${built.linkErrors}`)
			cli = built
			commands = commandsOf(app.document)
		},
		prepareTimeoutMs: 600_000,
		async run(cell: Cell, app) {
			if (cli === undefined) throw new Error("the CLI runner ran a cell before prepare")
			const env = setupEnv(cell.setup, app, mkdtempSync(join(goCacheDir("tmp"), "cli-setup-")))
			const out: Observed[] = []
			for (const call of cell.calls) {
				if (call.argv !== undefined) {
					out.push(await observedArgv(cli, call.argv, env))
					continue
				}
				const command = commands.get(call.operation)
				if (command === undefined) throw new Error(`no command for the operation ${call.operation}`)
				out.push(await observed({ app, cli, env }, call, command))
			}
			return out
		},
		target: "cli",
	}
}

describe.skipIf(!withGo())("cli toolchain", () => {
	const app = targetSuite(cliRunner())

	describe("the reference app's CLI at the go 1.24 floor", () => {
		it("builds and vets at the floor toolchain", () => {
			const built = builtCli(generateGoCli(app().document).files, { toolchain: GO_FLOOR })
			expect({ built: built.built, link: built.linkErrors, vet: built.vet }, built.stderr).toEqual({
				built: true,
				link: "",
				vet: [],
			})
		}, 600_000)
	})
})

describe("conformance × cli lacks", () => {
	it("lacks only cells the grid holds for cli", () => {
		const keys = new Set(cellsFor("cli").map((cell) => cell.key))
		expect(Object.keys(LACKS).filter((key) => !keys.has(key))).toEqual([])
	})
})
