/**
 * "Ships to Maven Central" (bit 16 phase f, item 6; bits/16 Scope): the emitted build publishes. `maven-publish` holds
 * a `mavenJava` publication from the Java component with its sources and javadoc jars (Central requires both), its POM
 * named and described by the document's `info`. The Javadoc task fails on any doclint finding but a missing comment
 * (`-Xdoclint:all,-missing -Werror`, C#'s `TreatWarningsAsErrors` with only CS1591 waived). An offline
 * `publishToMavenLocal` on Gradle's JDK 21 writes the four artifacts; spec text reaches the POM as written, never as
 * Groovy; a broken `{@link}` fails the build. What else Central requires of a POM comes from options:
 * `--java-homepage` (its url), `--java-license` (an SPDX id, linked to spdx.org), `--java-developers` (one developer per
 * author, each a name or `Name <email>`, comma separated; every author of the metadata block by default, plan 39 8.6)
 * and `--java-repository` (scm's url, connection and developer connection), each left out when not given and refused
 * at generate when invalid; `--java-description` replaces the document's. Signing stays the publisher's.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { compiledJavaSdk } from "./__fixtures__/compiled.ts"
import { runGradle, withJava } from "./__fixtures__/java-env.ts"
import { generateJavaSdk, type JavaSdkOptions } from "./sdk.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** A cold Gradle build takes minutes. */
const SLOW = { timeout: 600_000 }

/** Spec text a build must never read as Groovy: both quotes, a `$`, a backslash, a newline. */
const HOSTILE = { description: 'It\'s "one" line\nand ${System.exit(1)} \\u0041 another', title: "Anyrow's API" }
const DOCUMENT = { info: { ...HOSTILE, version: "1" }, openapi: "3.1.0", paths: {} }

const build = (options: JavaSdkOptions = {}) => generateJavaSdk(DOCUMENT, options).files["build.gradle"] ?? ""

/** The POM metadata a Central publication needs: a developer whose name Groovy would read as code unescaped, and one
 * named alone. */
const METADATA = {
	developers: "Ada O'Brien ${x} <ada@example.com>, Bo",
	homepage: "https://shop.example.com",
	license: "Apache-2.0",
	repository: "https://github.com/acme/shop-java.git/",
} as const satisfies JavaSdkOptions

describe("build.gradle: the publication (item 6)", () => {
	/* new: red before item 6, when the build had no publication */
	it("applies maven-publish, adds the sources and javadoc jars, and publishes the Java component as mavenJava", () => {
		const text = build()
		expect({
			jars: /java \{\n {4}withSourcesJar\(\)\n {4}withJavadocJar\(\)\n\}/.test(text),
			plugin: /^ {4}id 'maven-publish'$/m.test(text),
			publication: /mavenJava\(MavenPublication\) \{\n {12}from components\.java/.test(text),
		}).toEqual({ jars: true, plugin: true, publication: true })
	})

	/* new: C#'s doc gate in Java's words: every doclint group but missing, warnings as errors */
	it("runs javadoc under -Xdoclint:all,-missing -Werror", () => {
		expect(build()).toMatch(
			/tasks\.withType\(Javadoc\)\.configureEach \{\n {4}options\.addBooleanOption\('Xdoclint:all,-missing', true\)\n {4}options\.addBooleanOption\('Werror', true\)\n\}/,
		)
	})

	/* new: spec text is a single-quoted Groovy string: nothing in it interpolates or ends it */
	it("writes the POM's name and description from info as single-quoted Groovy strings, escaped", () => {
		expect(build()).toContain(
			"name = 'Anyrow\\'s API'\n                description = 'It\\'s \\\"one\\\" line\\nand ${System.exit(1)} \\\\u0041 another'",
		)
	})

	/* new: an info with no title names the POM by the artifact id, and describes it by that name */
	it("names and describes the POM by the artifact id when info has no title or description", () => {
		const untitled = { info: { version: "1" }, openapi: "3.1.0", paths: {} }
		expect(generateJavaSdk(untitled).files["build.gradle"]).toContain(
			"name = 'anyrow'\n                description = 'anyrow'",
		)
	})
})

describe("build.gradle: the POM metadata Central requires", () => {
	it("writes the url, the license, the developers and the scm the options give, as escaped Groovy strings", () => {
		expect(build(METADATA))
			.toContain(`                description = 'It\\'s \\"one\\" line\\nand \${System.exit(1)} \\\\u0041 another'
                url = 'https://shop.example.com'
                licenses {
                    license {
                        name = 'Apache-2.0'
                        url = 'https://spdx.org/licenses/Apache-2.0.html'
                    }
                }
                developers {
                    developer {
                        name = 'Ada O\\'Brien \${x}'
                        email = 'ada@example.com'
                    }
                    developer {
                        name = 'Bo'
                    }
                }
                scm {
                    url = 'https://github.com/acme/shop-java'
                    connection = 'scm:git:https://github.com/acme/shop-java.git'
                    developerConnection = 'scm:git:https://github.com/acme/shop-java.git'
                }
            }`)
	})

	it("writes none of them when no option is given", () => {
		expect(["url = ", "licenses {", "developers {", "scm {"].filter((line) => build().includes(line))).toEqual([])
	})

	it("describes the POM by --java-description over the document's", () => {
		expect(build({ description: "Shop's Java client" })).toContain("description = 'Shop\\'s Java client'\n")
	})

	it.each<[keyof typeof METADATA | "description", string]>([
		["description", ""],
		["description", "two\nlines"],
		["homepage", "http://shop.example.com"],
		["homepage", "https://shop.example.com/a b"],
		["license", "MIT OR Apache-2.0"],
		["license", "LicenseRef-Acme"],
		["license", "MIT'"],
		["repository", "https://github.com"],
		["repository", "git@github.com:acme/shop.git"],
		["developers", ""],
		["developers", "<ada@example.com>"],
		["developers", "Ada <ada>"],
		["developers", "Ada <ada@example.com> x"],
		["developers", "Ada,,Bo"],
	])("refuses %s %j at generate", (option, value) => {
		expect(() => build({ [option]: value })).toThrow(`Invalid ${option}: ${JSON.stringify(value)}`)
	})
})

describe.skipIf(!JAVA)("the publication, built offline on Gradle's JDK 21 (item 6)", SLOW, () => {
	/* new: Central requires the jar, the sources and javadoc jars and the POM; spec text reaches the POM as written */
	it("writes the jar, the sources jar, the javadoc jar and the POM to a local repository, info and metadata as written", () => {
		const sdk = compiledJavaSdk(generateJavaSdk(DOCUMENT, METADATA).files)
		const repo = join(dirname(sdk.out), "m2")
		const ran = runGradle(["-q", `-Dmaven.repo.local=${repo}`, "publishToMavenLocal"], { cwd: dirname(sdk.out) })
		const base = join(repo, "ai/anyrow/anyrow/0.1.0/anyrow-0.1.0")
		const pom = existsSync(`${base}.pom`) ? readFileSync(`${base}.pom`, "utf8") : ""
		const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(pom)?.[1]
		expect(
			{
				artifacts: [".jar", "-sources.jar", "-javadoc.jar", ".pom"].map((suffix) => existsSync(`${base}${suffix}`)),
				coordinates: [tag("groupId"), tag("artifactId"), tag("version")],
				info: [tag("name"), tag("description")],
				metadata: [tag("url"), tag("licenses"), tag("developers"), tag("scm")].map((block) =>
					block?.replace(/\s+/g, ""),
				),
				status: ran.status,
			},
			ran.stderr,
		).toEqual({
			artifacts: [true, true, true, true],
			coordinates: ["ai.anyrow", "anyrow", "0.1.0"],
			info: ["Anyrow's API", 'It\'s "one" line\nand ${System.exit(1)} \\u0041 another'],
			metadata: [
				"https://shop.example.com",
				"<license><name>Apache-2.0</name><url>https://spdx.org/licenses/Apache-2.0.html</url></license>",
				"<developer><name>AdaO'Brien${x}</name><email>ada@example.com</email></developer><developer><name>Bo</name></developer>",
				"<connection>scm:git:https://github.com/acme/shop-java.git</connection><developerConnection>scm:git:https://github.com/acme/shop-java.git</developerConnection><url>https://github.com/acme/shop-java</url>",
			],
			status: 0,
		})
	})

	/* new: the gate's other side: a doclint finding fails the javadoc jar, so the green above is a check */
	it("fails the javadoc jar on a broken {@link}, naming it", () => {
		/* a copy of the cached project: the cache keeps the SDK as emitted */
		const sdk = compiledJavaSdk(generateJavaSdk(DOCUMENT).files)
		const project = mkdtempSync(join(dirname(dirname(sdk.out)), "broken-link-"))
		cpSync(dirname(sdk.out), project, { recursive: true })
		/* the public client: javadoc documents, and so lints, public types alone */
		const client = join(project, "src/main/java/ai/anyrow/AnyrowClient.java")
		writeFileSync(client, readFileSync(client, "utf8").replace(/\/\*\*/, "/** See {@link Nowhere}."))
		const ran = runGradle(["-q", "javadocJar"], { cwd: project })
		rmSync(project, { force: true, recursive: true })
		expect([ran.status === 0, /error: reference not found/.test(`${ran.stdout}${ran.stderr}`)], ran.stderr).toEqual([
			false,
			true,
		])
	})
})
