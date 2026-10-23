/**
 * Toolchain parity (G10, G11, R7) for Java: gen runs java, javac, javap, Gradle and google-java-format only through
 * `src/emit/java/__fixtures__/java-env.ts`, on the releases `java-pins.json` pins by sha256. `javaInstall`'s command
 * fetches each pin, checks it and extracts it into `$HOME/.cache/honey-tmp/java/toolchain/<release>`; the Jackson set
 * and its POMs go into `$HOME/.cache/honey-tmp/java/repo` in Maven layout. Never PATH's java or gradle, never a
 * caller's `JAVA_HOME`, never a setup action. A run never installs: a missing pin skips, or fails where Java is
 * required, naming the install. The default run runs on JDK 21; 17 and 25 run in CI's matrix. CI reads the same pins
 * file with `jq`, in every job that runs gen's Java, beside the `-java-` cache.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, matchesGlob, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HARNESS, JAVA, RUST, TOOLCHAIN_PROJECTS } from "../../vitest.config.ts"
import * as env from "../../src/emit/java/__fixtures__/java-env.ts"

const { gjfJava, javaCacheDir, javaEnv, javaHome, javaInstall, runGjf, runGradle, runJava, withJava } = env

const GEN = resolve(import.meta.dirname, "../..")
const REPO = join(GEN, "../..")
const ROOTS = ["src", "tests", "scripts"]
const SELF = "tests/structure/java-toolchain.test.ts"
const ENV = "src/emit/java/__fixtures__/java-env.ts"
const FIXTURE_DIR = join(GEN, "src/emit/java/__fixtures__")
const PINS = join(FIXTURE_DIR, "java-pins.json")
const WORKFLOW = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8")

/* the files besides the env that may name a JDK home or the GJF jar: the compile fixture and the toolchain legs */
const HANDED = [
	"src/emit/java/__fixtures__/compiled.ts",
	"src/emit/java/format.test.ts",
	"src/emit/shared/escape.toolchains.test.ts",
	"src/emit/shared/webhooks.toolchains.test.ts",
]

/* a spawn of a JDK or build tool, a command list whose entry starts with one, or a `-jar` launch (a list of language
 * names is not one) */
const JAVA_COMMAND =
	/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*"(?:java|javac|javap|gradle|gradlew|google-java-format)"|\[\[\s*"(?:java|javac|javap|gradle|gradlew|google-java-format)",|"-jar",/

/* a test file importing the env, by its module's name */
const IMPORTS_ENV = /from "[^"]*java-env\.ts"/

/** Every TS file under `dir`, recursively, gen-relative. */
function tsFiles(dir: string): string[] {
	return readdirSync(join(GEN, dir)).flatMap((name) => {
		const path = join(dir, name)
		if (statSync(join(GEN, path)).isDirectory()) return name === "_tokenizer" ? [] : tsFiles(path)
		return name.endsWith(".ts") ? [path] : []
	})
}

/** Every gen TS file but this one and the env file, with its text. */
const others = () =>
	ROOTS.flatMap(tsFiles)
		.filter((path) => path !== SELF && path !== ENV)
		.map((path) => ({ path, text: readFileSync(join(GEN, path), "utf8") }))

/** The cache root, as the install and every run spell it. */
const cache = () => join(process.env.HOME ?? homedir(), ".cache/honey-tmp/java")

/** The pins as `java-pins.json` holds them: each release and artifact by its sha256, the Jackson set by Central's sha1 too. */
const PINNED = {
	gradle: {
		sha256: "21bd5da2de49b642904077f38c0efdc7778e92b3ed0889392dca61b97e389607",
		url: "https://services.gradle.org/distributions/gradle-9.8.2-bin.zip",
		version: "9.8.2",
	},
	googleJavaFormat: {
		sha256: "834b2a0c38cb774953322a84b5ca3f2f40dd3156650b3cd44d3b744345962f7a",
		url: "https://github.com/google/google-java-format/releases/download/v1.37.0/google-java-format-1.37.0-all-deps.jar",
		version: "1.37.0",
	},
	jdk: {
		"17": {
			release: "jdk-17.0.20.1+1",
			sha256: "3808d1d15e3ec6bd5b84057fb5d84c33d8a1536a258146bcea2e603fc726e08e",
			url: "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz",
			version: "17.0.20.1",
		},
		"21": {
			release: "jdk-21.0.12.1+1",
			sha256: "ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94",
			url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz",
			version: "21.0.12.1",
		},
		"25": {
			release: "jdk-25.0.4.1+1",
			sha256: "dbb698396d478e7fa2b1e50f4103324b2a99b90569ee27c33f2261f9215cf41e",
			url: "https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jdk_x64_linux_hotspot_25.0.4.1_1.tar.gz",
			version: "25.0.4.1",
		},
	},
	jackson: {
		artifacts: [
			{
				path: "com/fasterxml/jackson/core/jackson-annotations/2.22/jackson-annotations-2.22.jar",
				sha1: "15c67f9498d6934cff9510fc70c5a12e52290457",
				sha256: "21ddb598807d3a51a876704eb979d9296e1c6a6f47ab1826ff88c6d6a127a2d0",
			},
			{
				path: "com/fasterxml/jackson/core/jackson-annotations/2.22/jackson-annotations-2.22.pom",
				sha1: "e9aaa4f2c23cb6c4b983a0dfec3e406ec2b9f09b",
				sha256: "38c3ba52a0eade3e3eacc5b13499d56e1038ccbad8ec4bb79426dc21432b46d0",
			},
			{
				path: "com/fasterxml/jackson/jackson-parent/2.22/jackson-parent-2.22.pom",
				sha1: "32456e752caa8cffc0e6f72a3471ea184e0318eb",
				sha256: "7d45a7efb69df207bed7cc54b87a0bb012f10952c095570a273b49485da0d129",
			},
			{
				path: "com/fasterxml/oss-parent/79/oss-parent-79.pom",
				sha1: "20a6340c8b8635db53252cb435825b73cf12bb1d",
				sha256: "9206b7dd67fb138036576c3dfca947a2a8f3e2c4d2d9c1f2d1dea519b3a4dae1",
			},
			{
				path: "org/junit/junit-bom/6.0.3/junit-bom-6.0.3.pom",
				sha1: "d43a7b02d9b9f4eb8e5b36ba46d68975ad106791",
				sha256: "a655b6a5dc00d1bebc91fb2b15c0c7e8aeac9d6bdcf879595505370e27530287",
			},
			{
				path: "tools/jackson/core/jackson-core/3.2.4/jackson-core-3.2.4.jar",
				sha1: "025beaee139ae32025c5f189e4fb39c5b1f78653",
				sha256: "494b9f5fccf008042d5a72c5bf00629b144c0ba7362a9864cbb02234c9772651",
			},
			{
				path: "tools/jackson/core/jackson-core/3.2.4/jackson-core-3.2.4.pom",
				sha1: "22ea3da234b8a964cb2d4a7bd836c7cee0352415",
				sha256: "728897bac06417793b6b0d957ab7e4899fc880594df422296b17d196a8bdd170",
			},
			{
				path: "tools/jackson/core/jackson-databind/3.2.4/jackson-databind-3.2.4.jar",
				sha1: "73cd5c393378036c5b556355e5257128796b9a9a",
				sha256: "c4af37223d5024f1294a5450598b01b65f30c53d9e906f02c3955ba1fb14a67d",
			},
			{
				path: "tools/jackson/core/jackson-databind/3.2.4/jackson-databind-3.2.4.pom",
				sha1: "719b1302f8787befbf137b4cc43c9aa9e1039611",
				sha256: "ce888a26268256c5425d56f959a10fc9234a458bcd8b7299c07ea573a405d380",
			},
			{
				path: "tools/jackson/jackson-base/3.2.4/jackson-base-3.2.4.pom",
				sha1: "993234749727d6b7f884ba71b6ff8a6dce91d470",
				sha256: "6c89b94983cbd8c13a63527249b9fbf9027a2bf340d8fbe517c42c5c6bece821",
			},
			{
				path: "tools/jackson/jackson-bom/3.2.4/jackson-bom-3.2.4.pom",
				sha1: "40ca98cb99e9719611b9642bd2ab4e03d7081f3c",
				sha256: "264046f38cab063138669a3b4c6ea1841600250494c33cf5880e2e39225ba313",
			},
		],
		repository: "https://repo.maven.apache.org/maven2",
	},
}

type Pins = typeof PINNED

/** The pins file, parsed. */
const pins = (): Pins => JSON.parse(readFileSync(PINS, "utf8")) as Pins

/** The install command, which CI runs verbatim: it reads the same pins file with `jq`. */
const INSTALL = javaInstall()

/** Whether the pinned JDKs and tools are installed: nothing is fetched here. */
const PRESENT = withJava()

/** Each job's body under `jobs:`, by name. */
function jobs(workflow: string): Record<string, string> {
	const body = workflow.slice(workflow.indexOf("\njobs:\n"))
	return Object.fromEntries(
		[...body.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\n)*)/gm)].map(([, name, text]) => [name, text]),
	)
}

/** Each step of a job body, as its text. */
const steps = (job: string) => job.split(/^ {6}- /m)

/** The trimmed lines of each step's `run` in a job body. */
const runs = (job: string) =>
	steps(job).map((step) =>
		(/\brun: [|>]-?\n((?: {10}.*\n)*)|\brun: (.*)\n/.exec(step) ?? [])
			.slice(1)
			.join("")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	)

/** Whether a step saves or restores the java cache, keyed on content hashes. */
const cachesJava = (step: string) =>
	/^uses: actions\/cache(?:\/restore)?@v4\n/.test(step) &&
	/honey-tmp\/java\b/.test(step) &&
	/\}\}-java-\$\{\{ hashFiles\(/.test(step.replace(/\s+/g, " "))

/**
 * Whether gen-relative `path` is in the java project, in the rust project that runs after it, or in the opt-in harness,
 * whose java project runs Java's conformance runner and harness files (phase e)
 */
const owned = (path: string) => [...JAVA, ...RUST, ...HARNESS].some((glob) => matchesGlob(path, glob))

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

describe("Java runs through java-env.ts only", () => {
	it("leaves no gen file spawning java, javac, javap, gradle or google-java-format, or launching a -jar, but java-env.ts", () => {
		expect(
			others()
				.filter(({ text }) => JAVA_COMMAND.test(text))
				.map(({ path }) => path),
		).toEqual([])
	})

	it("recognizes a raw spawn, a command list and a -jar launch as running Java", () => {
		expect(
			[
				'spawnSync("java", ["-version"])',
				'spawn("javac")',
				'run: [["gradle", "build"]]',
				'spawnSync(bin, ["-jar", gjf])',
				'spawnSync("node")',
				'["go", "python", "csharp", "java", "rust"]',
			].map((t) => JAVA_COMMAND.test(t)),
		).toEqual([true, true, true, true, false, false])
	})

	it("hands out two paths, the JDK home and the GJF jar, and only to the compile fixture and the toolchain legs", () => {
		expect(Object.keys(env).filter((name) => /home|jar|root|path/i.test(name))).toEqual(["gjfJar", "javaHome"])
		const loose = others().filter(({ path, text }) => !HANDED.includes(path) && /\b(?:javaHome|gjfJar)\(/.test(text))
		expect(loose.map(({ path }) => path)).toEqual([])
	})
})

describe("the pins", () => {
	it("pin one exact release per JDK (17, 21, 25), google-java-format, Gradle and the Jackson set", () => {
		expect(pins()).toEqual(PINNED)
	})

	it("hold the Jackson set as its 3 jars and 8 POMs, each with Central's sha1 and our sha256", () => {
		const paths = pins().jackson.artifacts.map(({ path }) => path)
		expect([paths.filter((p) => p.endsWith(".jar")).length, paths.filter((p) => p.endsWith(".pom")).length]).toEqual([
			3, 8,
		])
	})
})

describe("CI installs the pins", () => {
	/* the jobs that run gen's Java: the harness (`bun run test:harness`), the java project's shard and the rust
	 * project's, whose toolchain files reach every language (vitest.config.ts, as for .NET) */
	it("in every job that runs gen's Java, by the command a missing JDK names, beside the java cache, with HONEY_REQUIRE_TOOLCHAINS", () => {
		const testing = Object.entries(jobs(WORKFLOW)).filter(([, job]) =>
			/^ +- run: bun run test:harness$|--project (?:java|rust)\b/m.test(job),
		)
		expect(testing.map(([name]) => name).sort()).toEqual(["gen-java", "gen-rust", "harness"])
		const missing = testing.filter(
			([, job]) =>
				!runs(job).some((lines) => lines.includes(INSTALL)) ||
				!steps(job).some(cachesJava) ||
				!/HONEY_REQUIRE_TOOLCHAINS: "1"/.test(job),
		)
		expect(missing.map(([name]) => name)).toEqual([])
	})

	it("reads the pins from java-pins.json with jq, in the one command the install names", () => {
		expect(INSTALL).toContain("java-pins.json")
		expect(INSTALL).toMatch(/\bjq\b/)
	})

	it("saves the -java- cache in gen-java alone, and gen-coverage waits on gen-java", () => {
		const gen = jobs(WORKFLOW)["gen-java"] ?? ""
		expect(steps(gen).some((step) => step.startsWith("uses: actions/cache@v4\n") && cachesJava(step))).toBe(true)
		expect(jobs(WORKFLOW)["gen-coverage"]).toMatch(/^ {4}needs: \[.*\bgen-java\b/m)
	})

	it("names no other JDK or build tool: no setup action, no JDK version input, no java, javac or gradle command but the install's", () => {
		const live = WORKFLOW.split("\n")
			.filter((line) => !/^\s*#/.test(line))
			.join("\n")
		expect(live.match(/actions\/setup-java\S*|\bjava-version\b.*|\btemurin\b.*|\bopenjdk\b.*/gi) ?? []).toEqual([])
		const commands = Object.values(jobs(WORKFLOW))
			.flatMap(runs)
			.flat()
			.filter((line) => line !== INSTALL)
			.map((line) => line.replace(/--project \S+/g, ""))
		expect(
			commands.filter((line) => /(?:^|[\s;&|("/])(?:javac?|javap|gradlew?|jdk\S*|openjdk\S*)(?:\s|$)/.test(line)),
		).toEqual([])
	})
})

describe("vitest runs gen's Java in its own project", () => {
	it("orders the toolchain projects go, python, csharp, java, then rust", () => {
		expect(Object.keys(TOOLCHAIN_PROJECTS)).toEqual(["go", "python", "csharp", "java", "rust"])
	})

	it("holds the java project to the java-toolchain test and every test under src/emit/java", () => {
		expect(JAVA).toEqual(["src/emit/java/**/*.test.ts", "tests/structure/java-toolchain.test.ts"])
	})

	it("runs every test file reaching java-env in java, in rust after it, or in the harness's java project", () => {
		const reaching = others()
			.filter(({ path, text }) => path.endsWith(".test.ts") && IMPORTS_ENV.test(text))
			.map(({ path }) => path)
		expect(reaching.filter((path) => !owned(path))).toEqual([])
	})
})

describe("what a run never does", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("never installs a missing pin: it skips, or fails naming the install where Java is required", () => {
		vi.stubEnv("HONEY_REQUIRE_TOOLCHAINS", "")
		vi.stubEnv("HONEY_REQUIRE_JAVA", "")
		vi.stubEnv("HOME", join(homedir(), "honey-no-java-here"))
		expect(withJava()).toBe(false)
		vi.stubEnv("HONEY_REQUIRE_JAVA", "1")
		expect(() => withJava()).toThrow(javaInstall())
	})

	it("sets the JDK, the Gradle home and TMPDIR under the cache, and leaves HOME the caller's", () => {
		const set = javaEnv()
		expect([set.GRADLE_USER_HOME, set.JAVA_HOME, set.TMPDIR].map((dir) => dir?.startsWith(`${cache()}/`))).toEqual([
			true,
			true,
			true,
		])
		expect(set.HOME).toBe(process.env.HOME)
		expect(set.PATH?.split(":")[0]).toBe(`${javaHome(21)}/bin`)
	})

	it("drops every variable a caller sets that would steer a JDK or Gradle, and keeps no caller's JAVA_HOME", () => {
		const steering = {
			CLASSPATH: "/caller",
			GRADLE_OPTS: "-Dx=1",
			JAVA_HOME: "/caller/jdk",
			JAVA_TOOL_OPTIONS: "-Dy=1",
			JDK_JAVA_OPTIONS: "-Dz=1",
			_JAVA_OPTIONS: "-Dw=1",
		}
		for (const [key, value] of Object.entries(steering)) vi.stubEnv(key, value)
		const set = javaEnv()
		const dropped = ["CLASSPATH", "GRADLE_OPTS", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"]
		expect(dropped.filter((key) => set[key] !== undefined)).toEqual([])
		expect(set.JAVA_HOME).toBe(javaHome(21))
	})
})

describe.skipIf(!PRESENT)("the pinned toolchains a run uses", () => {
	it("runs each pinned JDK at its pinned version, from the cache", () => {
		for (const major of ["17", "21", "25"] as const) {
			expect(javaHome(Number(major)).startsWith(cache())).toBe(true)
			expect(runJava(Number(major), ["-version"]).stderr).toContain(`version "${pins().jdk[major].version}"`)
		}
	})

	it("hold every pinned Jackson artifact in the repo to its sha1 and sha256", () => {
		const repo = join(cache(), "repo")
		const mismatched = pins()
			.jackson.artifacts.map(({ path, sha1, sha256 }) => {
				const file = readFileSync(join(repo, path))
				const digest = (algorithm: string) => createHash(algorithm).update(file).digest("hex")
				return { path, sha1: digest("sha1") === sha1, sha256: digest("sha256") === sha256 }
			})
			.filter((row) => !row.sha1 || !row.sha256)
			.map((row) => row.path)
		expect(mismatched).toEqual([])
	})

	it("runs the pinned Gradle from the cache", () => {
		expect(runGradle(["--version"]).stdout).toContain(`Gradle ${PINNED.gradle.version}`)
	})

	it("runs google-java-format on the 21 JDK alone, listing only the file it would change", () => {
		const dir = mkdtempSync(join(javaCacheDir("tmp"), "gjf-"))
		try {
			writeFileSync(join(dir, "Canon.java"), "public class Canon {}\n")
			writeFileSync(join(dir, "Loose.java"), "public class Loose{}\n")
			expect(gjfJava()).toBe(join(javaHome(21), "bin/java"))
			const listed = runGjf(["--dry-run", join(dir, "Canon.java"), join(dir, "Loose.java")])
			expect([listed.status, listed.stdout.includes("Loose.java"), listed.stdout.includes("Canon.java")]).toEqual([
				0,
				true,
				false,
			])
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

describe.skipIf(!PRESENT)("a Gradle build's daemon", () => {
	it("leaves no Gradle daemon alive after an offline build, checked by command line", async () => {
		const before = new Set(gradleDaemons())
		const dir = mkdtempSync(join(javaCacheDir("tmp"), "gradle-"))
		try {
			writeFileSync(join(dir, "settings.gradle"), "rootProject.name = 'probe'\n")
			writeFileSync(join(dir, "build.gradle"), "plugins { id 'java-library' }\n")
			mkdirSync(join(dir, "src", "main", "java"), { recursive: true })
			writeFileSync(join(dir, "src", "main", "java", "P.java"), "public class P {}\n")
			const built = runGradle(["--offline", "--no-daemon", "build"], { cwd: dir })
			expect([built.status, existsSync(join(dir, "build", "libs", "probe.jar"))]).toEqual([0, true])
			await vi.waitFor(() => expect(gradleDaemons().filter((line) => !before.has(line))).toEqual([]), {
				interval: 100,
				timeout: 5_000,
			})
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})
