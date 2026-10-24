/**
 * The generated CLI, built: its module written, built and vetted by `compileGo` (go-env's pinned toolchain, or a
 * floor toolchain), then linked once per content hash into a static binary (`CGO_ENABLED=0`, `-trimpath`) with the
 * version a release would stamp. `cli(args)` runs that binary as a user would, without blocking the event loop, so
 * an in-process server keeps answering meanwhile; its environment is only what the call passes, PATH aside, and its
 * HOME a fresh empty directory, so no config file of the machine's or another run's reaches it.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import { type Compiled, compileGo } from "../../go/__fixtures__/compiled.ts"
import { goCacheDir, runGo } from "../../go/__fixtures__/go-env.ts"

/** The version every built CLI is stamped with, as a release's `-ldflags -X` stamps it. */
export const STAMPED = "v1.2.3-test"

/** A run of the CLI: its exit status and output. */
export type Ran = {
	readonly status: number
	readonly stderr: string
	readonly stdout: string
	/** stdout's bytes as written: a binary answer's, undecoded */
	readonly stdoutBytes: Buffer
}

export type BuiltCli = Compiled & {
	/** the linked binary's path; empty when the build or the link failed */
	readonly binary: string
	/** the link's errors, if any */
	readonly linkErrors: string
	/** run the binary with `args`, as `options` gives it */
	cli(args: readonly string[], options?: RunOptions): Promise<Ran>
}

/** The module path a go.mod declares. */
const moduleOf = (files: Readonly<Record<string, string>>) => /^module (\S+)$/m.exec(files["go.mod"] ?? "")?.[1] ?? ""

/** How the binary is linked: a release's flags, cgo off. */
const linkSettings = (modulePath: string) => ({
	env: { CGO_ENABLED: "0" },
	flags: ["-trimpath", "-ldflags", `-s -w -X ${modulePath}/internal/cli.Version=${STAMPED}`],
})

/**
 * The binary's path in `dir`, named by its link settings: a cached module dir (CI restores the last set) never hands
 * back a binary linked another way.
 */
const binaryIn = (dir: string, modulePath: string) =>
	join(
		dir,
		"bin",
		createHash("sha256")
			.update(JSON.stringify(linkSettings(modulePath)))
			.digest("hex")
			.slice(0, 12),
	)

/** Link the module's binary once, beside its final name then renamed; the link's errors, if any. */
function linkOnce(dir: string, modulePath: string, toolchain: string | undefined): string {
	const binary = binaryIn(dir, modulePath)
	if (existsSync(binary)) return ""
	mkdirSync(dirname(binary), { recursive: true })
	const partial = `${binary}.${process.pid}.partial`
	const { env, flags } = linkSettings(modulePath)
	const link = runGo(["build", ...flags, "-o", partial, "."], { cwd: dir, env, toolchain })
	if (link.status !== 0) return link.stderr
	renameSync(partial, binary)
	return ""
}

/** How a run is given: its environment beside PATH and HOME, its stdin, and when to interrupt it. */
export type RunOptions = {
	/** the environment beside PATH; HOME is a fresh empty directory unless this names one */
	readonly env?: NodeJS.ProcessEnv
	readonly input?: string
	/** once this settles, the run is sent SIGINT, as Ctrl-C sends it */
	readonly interrupt?: Promise<unknown>
	/** run on a terminal: under script(1)'s pseudo-terminal, as a person types it (its \r\n read back as \n) */
	readonly tty?: true
}

/** An argument as a POSIX shell reads it back: single-quoted, each quote closed and escaped. */
const quoted = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`

/** The binary's run with `args`, as a promise. */
function runIn(binary: string, args: readonly string[], options: RunOptions): Promise<Ran> {
	const home = mkdtempSync(join(goCacheDir("cli-home"), "home-"))
	return new Promise((resolve, reject) => {
		const env = { HOME: home, PATH: process.env.PATH, ...options.env }
		const [command, argv] = options.tty
			? ["script", ["-qec", [binary, ...args].map(quoted).join(" "), "/dev/null"]]
			: [binary, [...args]]
		const child = spawn(command, argv, { env })
		const out: Buffer[] = []
		let stderr = ""
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
		child.once("error", reject)
		const read = (text: string) => (options.tty ? text.replaceAll("\r\n", "\n") : text)
		child.once("close", (status) => {
			const stdoutBytes = Buffer.concat(out)
			resolve({ status: status ?? 1, stderr: read(stderr), stdout: read(stdoutBytes.toString()), stdoutBytes })
		})
		child.stdin.on("error", () => {
			/* a CLI that exits without reading its input: its exit status answers */
		})
		child.stdin.end(options.input ?? "")
		void options.interrupt?.then(() => child.kill("SIGINT"))
	})
}

/** `files` (a CLI module) built, vetted and linked at the pinned toolchain, or at `toolchain` (the floor legs). */
export function builtCli(files: Readonly<Record<string, string>>, options: { readonly toolchain?: string } = {}) {
	const compiled = compileGo(files, options)
	const modulePath = moduleOf(files)
	const linkErrors = compiled.built ? linkOnce(compiled.dir, modulePath, options.toolchain) : ""
	const binary = compiled.built && linkErrors === "" ? binaryIn(compiled.dir, modulePath) : ""
	return {
		...compiled,
		binary,
		cli: (args, run = {}) => runIn(binary, args, run),
		linkErrors,
	} satisfies BuiltCli
}
