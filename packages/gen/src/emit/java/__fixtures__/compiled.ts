/**
 * An emitted Java SDK held to the pinned toolchain (java-env.ts), once per content hash: written under
 * `$HOME/.cache/honey-tmp/java/sdk/<hash>`, compiled by the 21 JDK's javac `--release 17 -Xlint:all -Werror` against
 * exactly the three pinned jars, and checked on demand by google-java-format `--dry-run` and one offline Gradle build.
 */
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { type AsyncRun, execJava, javaCacheDir, runGjf, runGradle, runJava, runJavac } from "./java-env.ts"

type Files = Readonly<Record<string, string>>

/** A driver run: javac's diagnostics on it, then the program's exit status and output (none when it did not compile). */
export type JavaRun = {
	readonly diagnostics: readonly string[]
	readonly status: number
	readonly stderr: string
	readonly stdout: string
}

/** What javac made of the sources: its diagnostic lines and the class files it wrote, out-relative. */
type Javac = { readonly classes: readonly string[]; readonly diagnostics: readonly string[] }

export type CompiledJavaSdk = {
	/** `<cache>/sdk/<hash>`, the files as given */
	readonly dir: string
	/** the jars javac compiled against: the pinned Jackson set */
	readonly classpath: readonly string[]
	readonly javac: Javac
	/** the source paths GJF `--dry-run` would change, `src/main/java/`-relative; [] when canonical */
	format(): readonly string[]
	/** one offline Gradle build: its exit status and the Gradle daemons it left alive */
	gradle(): { readonly daemons: readonly string[]; readonly status: number }
	/** the SDK's compiled classes, `dir/out`: the driver's classpath beside the jars */
	readonly out: string
	/** the driver `source`, class `main` (dotted), compiled against the SDK and run on the 21 JDK, synchronously */
	run(main: string, source: string): JavaRun
	/** `run`, asynchronously: the recording server answers while the program runs (a leg that needs it) */
	exec(main: string, source: string): Promise<JavaRun>
}

/* the three jars the emitted build declares, Maven-relative in the cache's repo */
const JARS = [
	"com/fasterxml/jackson/core/jackson-annotations/2.22/jackson-annotations-2.22.jar",
	"tools/jackson/core/jackson-core/3.2.4/jackson-core-3.2.4.jar",
	"tools/jackson/core/jackson-databind/3.2.4/jackson-databind-3.2.4.jar",
]

/** Every file under `dir`, recursively, `dir`-relative. */
function walk(dir: string): string[] {
	if (!existsSync(dir)) return []
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name)
		return statSync(path).isDirectory() ? walk(path).map((inner) => join(name, inner)) : [name]
	})
}

/** The Gradle daemons alive now, as `pid cmdline`. */
function gradleDaemons(): string[] {
	return readdirSync("/proc")
		.filter((name) => /^\d+$/.test(name))
		.flatMap((pid) => {
			const path = join("/proc", pid, "cmdline")
			/* a process that ended since the listing has no cmdline left to read */
			const line = existsSync(path) ? readFileSync(path, "utf8").replaceAll("\0", " ") : ""
			return /GradleDaemon|GradleWrapperMain|gradle-launcher/.test(line) ? [`${pid} ${line.trim()}`] : []
		})
}

/**
 * The Gradle daemons alive that `before` did not hold, once the build's own single-use daemon has had 5 s to exit:
 * `--no-daemon` still forks one when the build's JVM arguments differ from the launcher's, and it outlives the build
 * by a moment.
 */
function leftAfter(before: ReadonlySet<string>): string[] {
	const pause = new Int32Array(new SharedArrayBuffer(4))
	for (let waited = 0; ; waited += 100) {
		const left = gradleDaemons().filter((line) => !before.has(line))
		if (left.length === 0 || waited >= 5_000) return left
		Atomics.wait(pause, 0, 0, 100)
	}
}

/** `files` written under `dir`, once: a dir that holds its `.complete` marker is already written. */
function written(dir: string, files: Files): void {
	if (existsSync(join(dir, ".complete"))) return
	rmSync(dir, { force: true, recursive: true })
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true })
		writeFileSync(join(dir, name), text)
	}
	writeFileSync(join(dir, ".complete"), "")
}

/**
 * The SDK written and compiled under `dir`, once: built in a private sibling directory and renamed into place, so a
 * concurrent test (vitest runs files in parallel) never reads a half-built `out`. A lost rename keeps the winner's.
 */
function materialized(dir: string, files: Files, classpath: readonly string[]): Javac {
	if (!existsSync(join(dir, ".complete"))) {
		const tmp = `${dir}.${randomUUID()}`
		written(tmp, files)
		compiled(tmp, classpath)
		try {
			renameSync(tmp, dir)
		} catch {
			rmSync(tmp, { force: true, recursive: true })
		}
	}
	return JSON.parse(readFileSync(join(dir, "javac.json"), "utf8")) as Javac
}

/** javac on the sources under `dir`, into `dir/out`, once per dir: kept in `dir/javac.json`. */
function compiled(dir: string, classpath: readonly string[]): Javac {
	const kept = join(dir, "javac.json")
	if (existsSync(kept)) return JSON.parse(readFileSync(kept, "utf8")) as Javac
	const out = join(dir, "out")
	rmSync(out, { force: true, recursive: true })
	mkdirSync(out, { recursive: true })
	const sources = walk(join(dir, "src")).map((name) => join(dir, "src", name))
	const args = ["--release", "17", "-Xlint:all", "-Werror", "-cp", classpath.join(":"), "-d", out, ...sources]
	const ran = runJavac(21, args, { cwd: dir })
	const diagnostics = `${ran.stdout}${ran.stderr}`.split("\n").filter((line) => line.trim() !== "")
	const result = { classes: walk(out).filter((name) => name.endsWith(".class")), diagnostics }
	writeFileSync(kept, JSON.stringify(result))
	return result
}

/**
 * The driver `source` as class `main`, compiled once under `dir/programs/<hash of main and source>` against `out` and
 * `classpath`; its diagnostics and status when it does not compile. Each program has its own directory, built in a
 * private sibling and renamed into place, so concurrent tests running programs against one SDK never clobber one
 * another's sources or classes. A lost rename keeps the winner's.
 */
function prepared(dir: string, classpath: readonly string[], main: string, source: string): JavaRun | Compiled {
	const hash = createHash("sha256").update(`${main}\0${source}`).digest("hex").slice(0, 16)
	const root = join(dir, "programs", hash)
	const cp = [join(dir, "out"), ...classpath].join(":")
	if (!existsSync(join(root, "javac.json"))) {
		const tmp = `${root}.${randomUUID()}`
		const path = join(tmp, "src", `${main.replaceAll(".", "/")}.java`)
		mkdirSync(dirname(path), { recursive: true })
		mkdirSync(join(tmp, "out"), { recursive: true })
		writeFileSync(path, source)
		const javac = runJavac(21, ["--release", "17", "-Xlint:all", "-Werror", "-cp", cp, "-d", join(tmp, "out"), path], {
			cwd: dir,
		})
		const diagnostics = `${javac.stdout}${javac.stderr}`.split("\n").filter((line) => line.trim() !== "")
		writeFileSync(join(tmp, "javac.json"), JSON.stringify({ diagnostics, status: javac.status ?? 1 }))
		try {
			renameSync(tmp, root)
		} catch {
			rmSync(tmp, { force: true, recursive: true })
		}
	}
	const javac = JSON.parse(readFileSync(join(root, "javac.json"), "utf8")) as { diagnostics: string[]; status: number }
	if (javac.status !== 0) return { diagnostics: javac.diagnostics, status: javac.status, stderr: "", stdout: "" }
	return { cp: `${join(root, "out")}:${cp}`, dir, diagnostics: javac.diagnostics, main }
}

/** A prepared driver: what javac made of it, and the classpath and directory a run takes. */
type Compiled = {
	readonly cp: string
	readonly dir: string
	readonly diagnostics: readonly string[]
	readonly main: string
}

const finished = (
	ran: { status: number | null; stderr: string; stdout: string },
	diagnostics: readonly string[],
): JavaRun => ({
	diagnostics,
	status: ran.status ?? 1,
	stderr: ran.stderr,
	stdout: ran.stdout,
})

/** The driver `source` run synchronously. */
function driven(dir: string, classpath: readonly string[], main: string, source: string): JavaRun {
	const ready = prepared(dir, classpath, main, source)
	if ("status" in ready) return ready
	const ran = runJava(21, ["-cp", ready.cp, ready.main], { cwd: ready.dir })
	return finished({ status: ran.status, stderr: ran.stderr, stdout: ran.stdout }, ready.diagnostics)
}

/** The driver `source` run asynchronously. */
async function drivenAsync(dir: string, classpath: readonly string[], main: string, source: string): Promise<JavaRun> {
	const ready = prepared(dir, classpath, main, source)
	if ("status" in ready) return ready
	const ran: AsyncRun = await execJava(21, ["-cp", ready.cp, ready.main], { cwd: ready.dir })
	return finished(ran, ready.diagnostics)
}

/** The emitted SDK `files`, compiled and ready to check. */
export function compiledJavaSdk(files: Files): CompiledJavaSdk {
	const hash = createHash("sha256")
		.update(JSON.stringify(Object.entries(files)))
		.digest("hex")
		.slice(0, 16)
	const dir = join(javaCacheDir("sdk"), hash)
	const classpath = JARS.map((path) => join(javaCacheDir("repo"), path))
	const javac = materialized(dir, files, classpath)
	const sourceRoot = join(dir, "src/main/java")
	return {
		classpath,
		dir,
		format: () => {
			const sources = walk(sourceRoot).map((name) => join(sourceRoot, name))
			const listed = runGjf(["--dry-run", ...sources])
				.stdout.split("\n")
				.filter((line) => line !== "")
			return listed.map((path) => relative(sourceRoot, path))
		},
		gradle: () => {
			const before = new Set(gradleDaemons())
			const status = runGradle(["-q", "build"], { cwd: dir }).status ?? 1
			return { daemons: leftAfter(before), status }
		},
		javac,
		out: join(dir, "out"),
		run: (main, source) => driven(dir, classpath, main, source),
		exec: (main, source) => drivenAsync(dir, classpath, main, source),
	}
}
