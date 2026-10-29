/**
 * The one way gen runs Java (G10, G11, R7): every java, javac, javap, Gradle and google-java-format a test, a fixture
 * or the harness spawns goes through here. It runs only the releases `java-pins.json` pins by sha256, extracted into
 * `$HOME/.cache/honey-tmp/java/toolchain/<release>` by `javaInstall`'s command after each checksum passes: never a
 * java or gradle on PATH, never a caller's `JAVA_HOME`. The Jackson set and its POMs live in `…/java/repo` in Maven
 * layout, and every Gradle run resolves from that repo alone, offline, with no daemon. The default run uses JDK 21
 * (google-java-format needs it); 17 and 25 are CI's matrix. Downloads are manual: a missing pin fails where Java is
 * required, naming its install, and is never fetched by a run. A structure test forbids a Java spawn elsewhere.
 */
import { type ChildProcessWithoutNullStreams, type SpawnSyncReturns, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { javaInstall } from "../../shared/__fixtures__/installs.ts"

/* this dir, repo-relative, as the install line names it from the repo's top level */

/** A pinned download: where it comes from, its digest and its version. */
type Pinned = { readonly sha256: string; readonly url: string; readonly version: string }

/** What `java-pins.json` holds. */
type Pins = {
	readonly gradle: Pinned
	readonly googleJavaFormat: Pinned
	readonly jdk: Readonly<Record<string, Pinned & { readonly release: string }>>
	readonly jackson: {
		readonly artifacts: readonly { readonly path: string; readonly sha1: string; readonly sha256: string }[]
		readonly repository: string
	}
}

/** The pins file, read on use. */
const pins = (): Pins => JSON.parse(readFileSync(resolve(import.meta.dirname, "java-pins.json"), "utf8")) as Pins

/** Where gen's Java lives: one area under the toolchain cache, made on first use. */
export function javaCacheDir(...parts: string[]): string {
	const dir = join(process.env.HOME ?? homedir(), ".cache/honey-tmp/java", ...parts)
	mkdirSync(dir, { recursive: true })
	return dir
}

/** The cache root without making it: a presence check never writes. */
const root = () => join(process.env.HOME ?? homedir(), ".cache/honey-tmp/java")

/** The google-java-format jar the pins name. */
export const gjfJar = (): string =>
	join(root(), "toolchain", `google-java-format-${pins().googleJavaFormat.version}.jar`)

/** The pinned JDK `major`'s home: its extracted tarball, `bin/java` inside. */
export function javaHome(major: number): string {
	const jdk = pins().jdk[String(major)]
	if (jdk === undefined) throw new Error(`no JDK ${major} is pinned in java-pins.json`)
	return join(root(), "toolchain", jdk.release)
}

/** The JDK google-java-format runs on: 21, since its classes are built for 21. */
export const gjfJava = (): string => join(javaHome(21), "bin/java")

/** The pinned Gradle's launcher. */
const gradleBin = () => join(root(), "toolchain", `gradle-${pins().gradle.version}`, "bin/gradle")

/* a caller's variable that would steer a JDK or Gradle: removed, not blanked */
const STEERING =
	/^(?:CLASSPATH|GRADLE_OPTS|JAVA_HOME|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|GRADLE_USER_HOME)$/

/**
 * The environment every Java command runs with: a caller's steering variables removed, the 21 JDK first on PATH and
 * as `JAVA_HOME`, Gradle's home and TMPDIR under the cache. HOME is left as it is.
 */
export function javaEnv(): NodeJS.ProcessEnv {
	const kept = Object.entries(process.env).filter(([key]) => !STEERING.test(key))
	const home = javaHome(21)
	const set = { GRADLE_USER_HOME: javaCacheDir("gradle-home"), JAVA_HOME: home, TMPDIR: javaCacheDir("tmp") }
	const path = [join(home, "bin"), process.env.PATH ?? ""].filter(Boolean).join(":")
	return { ...Object.fromEntries(kept), ...set, PATH: path }
}

/** How a Java command runs: in `cwd`, with `input` on stdin, `env` over the env every run uses. */
type RunOptions = {
	readonly cwd?: string
	readonly env?: Readonly<Record<string, string>>
	readonly input?: string
}

/** `bin` of the cache on `args`, under the env every run uses. */
function run(bin: string, args: readonly string[], options: RunOptions): SpawnSyncReturns<string> {
	return spawnSync(bin, [...args], {
		cwd: options.cwd,
		encoding: "utf8",
		env: { ...javaEnv(), ...options.env },
		input: options.input,
		maxBuffer: 1 << 26,
	})
}

/**
 * A JVM's own log, warnings included, routed to stderr: by default it goes to stdout, the program's channel, where a
 * warning under load ("[0.004s][warning]...") broke a driver's JSON. Its format stays the default one.
 */
const JVM_LOG = ["-Xlog:disable", "-Xlog:all=warning:stderr:uptime,level,tags"]

/** The pinned JDK `major`'s `java` on `args`. */
export const runJava = (major: number, args: readonly string[], options: RunOptions = {}) =>
	run(join(javaHome(major), "bin/java"), [...JVM_LOG, ...args], options)

/** The pinned JDK `major`'s `javac` on `args`. */
export const runJavac = (major: number, args: readonly string[], options: RunOptions = {}) =>
	run(join(javaHome(major), "bin/javac"), args, options)

/** What an async Java run returns: its exit status (null when killed by a signal) and both streams. */
export type AsyncRun = { readonly status: number | null; readonly stderr: string; readonly stdout: string }

/**
 * The pinned JDK `major`'s `java` on `args`, asynchronously: `input` on stdin, both streams collected. Async so the
 * in-process recording server (shared/__fixtures__/recording-server.ts) answers the JVM while it runs. With `killAfterMs`,
 * a JVM still running then is killed (status null), stderr saying so: a program that hangs reds in seconds, never at
 * the describe's 600 s bound.
 */
export function execJava(
	major: number,
	args: readonly string[],
	options: RunOptions & { readonly killAfterMs?: number } = {},
): Promise<AsyncRun> {
	return new Promise((done, reject) => {
		const child = spawnJava(major, args, options)
		let stdout = ""
		let stderr = ""
		const bound =
			options.killAfterMs === undefined
				? undefined
				: setTimeout(() => {
						stderr += `honey: the program was killed, still running after ${options.killAfterMs} ms\n`
						child.kill("SIGKILL")
					}, options.killAfterMs)
		child.on("close", () => clearTimeout(bound))
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk
		})
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk
		})
		child.on("error", reject)
		child.on("close", (status) => done({ status, stderr, stdout }))
		child.stdin.end(options.input ?? "")
	})
}

/**
 * The pinned `major`'s java on `args`, its stdin left open (bit 21 i6): a JVM a caller keeps for many runs (the
 * driver's serve mode), writing to it and ending it. execJava's spawn too.
 */
export function spawnJava(
	major: number,
	args: readonly string[],
	options: RunOptions = {},
): ChildProcessWithoutNullStreams {
	return spawn(join(javaHome(major), "bin/java"), [...JVM_LOG, ...args], { cwd: options.cwd, env: javaEnv() })
}

/** google-java-format on `args`, on the 21 JDK. */
export const runGjf = (args: readonly string[], options: RunOptions = {}) =>
	run(gjfJava(), [...JVM_LOG, "-jar", gjfJar(), ...args], options)

/** The init script every Gradle run takes: the cache's repo is its only repository. */
function offlineInit(): string {
	const path = join(javaCacheDir("gradle-home"), "honey-offline.gradle")
	const repo = join(root(), "repo")
	const text = `allprojects { repositories { clear(); maven { url = uri("file://${repo}") } } }\n`
	if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text)
	return path
}

/** The pinned Gradle on `args`: always offline, no daemon, the cache's repo alone. */
export function runGradle(args: readonly string[], options: RunOptions = {}): SpawnSyncReturns<string> {
	const forced = ["--offline", "--no-daemon", "--init-script", offlineInit()].filter((flag) => !args.includes(flag))
	return run(gradleBin(), [...forced, ...args], options)
}

/** Whether every pin is installed: each JDK's java, the jar, Gradle and the Jackson set. Nothing is fetched. */
export function hasJava(): boolean {
	const p = pins()
	const tools = [...Object.keys(p.jdk).map((major) => join(javaHome(Number(major)), "bin/java")), gjfJar(), gradleBin()]
	const repo = p.jackson.artifacts.map(({ path }) => join(root(), "repo", path))
	return [...tools, ...repo].every((file) => existsSync(file))
}

/** Whether a missing pin must fail rather than skip: CI and the pre-push battery set one of these. */
export const javaRequired = (): boolean =>
	process.env.HONEY_REQUIRE_TOOLCHAINS === "1" || process.env.HONEY_REQUIRE_JAVA === "1"

/**
 * Whether a test runs its Java half: false only where Java may be absent. A missing pin fails where it is required
 * (CI, the pre-push battery), naming its install, and skips anywhere else. Callers gate with `describe.skipIf`.
 */
export function withJava(): boolean {
	const present = hasJava()
	if (!present && javaRequired())
		throw new Error(`the pinned Java toolchain is required here and is not installed: ${javaInstall()}`)
	return present
}

export { javaInstall }
