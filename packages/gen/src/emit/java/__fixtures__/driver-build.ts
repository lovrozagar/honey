/**
 * The Java test driver's classes (bit 16 phase c1, C2): the fixed program under `driver/`, compiled once per hash of
 * its sources and the classpath it compiles against, by the pinned 21 JDK's javac `--release 17 -Xlint:all -Werror`.
 * The driver names no SDK type at compile time: it reaches the SDK by reflection, as the C# driver does.
 */
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { javaCacheDir, runJavac } from "./java-env.ts"

/** The driver's sources, by file name. */
function sources(): Record<string, string> {
	const dir = join(import.meta.dirname, "driver")
	return Object.fromEntries(
		readdirSync(dir)
			.filter((name) => name.endsWith(".java"))
			.sort()
			.map((name) => [name, readFileSync(join(dir, name), "utf8")]),
	)
}

/** The directory of the driver's classes, built once for `classpath`; a driver that does not build throws. */
export function driverClasses(classpath: readonly string[]): string {
	const files = sources()
	const hash = createHash("sha256")
		.update(JSON.stringify({ classpath, files: Object.entries(files) }))
		.digest("hex")
		.slice(0, 20)
	const dir = join(javaCacheDir("driver"), hash)
	const out = join(dir, "out")
	if (existsSync(join(dir, ".complete"))) return out
	/* built in a private sibling and renamed into place: a concurrent test never reads a half-built driver */
	const tmp = `${dir}.${randomUUID()}`
	const src = join(tmp, "src")
	mkdirSync(src, { recursive: true })
	mkdirSync(join(tmp, "out"), { recursive: true })
	for (const [name, text] of Object.entries(files)) writeFileSync(join(src, name), text)
	const args = ["--release", "17", "-Xlint:all", "-Werror", "-cp", classpath.join(":"), "-d", join(tmp, "out")]
	const ran = runJavac(21, [...args, ...Object.keys(files).map((name) => join(src, name))], { cwd: tmp })
	if (ran.status !== 0) throw new Error(`the Java test driver does not build:\n${ran.stdout}${ran.stderr}`)
	writeFileSync(join(tmp, ".complete"), "")
	try {
		renameSync(tmp, dir)
	} catch {
		rmSync(tmp, { force: true, recursive: true })
	}
	return out
}
