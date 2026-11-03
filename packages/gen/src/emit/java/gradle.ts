/**
 * The Java package's build and its option rules (bit 16 phase a, D3, D4): a Gradle `java-library` build compiled
 * `--release 17` with `-Xlint:all -Werror`, Maven Central, the one Jackson 3 dependency and the `mavenJava` publication;
 * no toolchain block, since auto-provisioning would fetch, and no wrapper, a binary the consumer's own Gradle 9
 * replaces. Every name the build and the sources spell comes from a validated option, never from spec text; the POM's
 * name and description are the document's words, written only as escaped single-quoted Groovy strings. The rest of
 * what Maven Central requires of a POM (its URL, license, developers and scm) comes from options, each validated and
 * written the same way, and is left out when not given.
 */
import { escapeText } from "../shared/escape.ts"
import { checked, HTTPS_URL, PERSON, personOf, SPDX_ID, TEXT } from "../shared/metadata.ts"

/** The package's identity, each part validated. */
export type JavaPackage = {
	readonly artifactId: string
	readonly clientName: string
	readonly groupId: string
	readonly packageName: string
	readonly version: string
}

/** The one runtime dependency, its coordinates pinned with the test classpath's (java-pins.json). */
export const JACKSON = "tools.jackson.core:jackson-databind:3.2.4"

/* Java's keywords and literals (JLS 3.9, 3.10.3, 3.10.7): no package segment may be one, and `_` is one since 9 */
const RESERVED = [
	"abstract",
	"assert",
	"boolean",
	"break",
	"byte",
	"case",
	"catch",
	"char",
	"class",
	"const",
	"continue",
	"default",
	"do",
	"double",
	"else",
	"enum",
	"extends",
	"final",
	"finally",
	"float",
	"for",
	"goto",
	"if",
	"implements",
	"import",
	"instanceof",
	"int",
	"interface",
	"long",
	"native",
	"new",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"short",
	"static",
	"strictfp",
	"super",
	"switch",
	"synchronized",
	"this",
	"throw",
	"throws",
	"transient",
	"try",
	"void",
	"volatile",
	"while",
	"true",
	"false",
	"null",
	"_",
]

/* the type names the client file spells or imports, and its nested Builder: a client of one of these clashes */
const SPELLED = ["Builder", "IllegalStateException", "String", "Transport", "URI"]

/* a Maven group: lowercase dotted words; an artifact: lowercase words joined by `-`; a package segment: a lowercase
 * identifier; a client: a PascalCase type */
const GROUP_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/
const ARTIFACT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SEGMENT = /^[a-z_][a-z0-9_]*$/
const CLIENT_NAME = /^[A-Z][A-Za-z0-9_]*$/
/* SemVer 2 (semver.org's recommended pattern), as the C# and Rust packages take it */
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

const refuse = (option: string, value: string): never => {
	throw new Error(`Invalid ${option}: ${JSON.stringify(value)}`)
}

/** A Maven group id: lowercase dotted words. */
export const validateGroupId = (value: string): string => (GROUP_ID.test(value) ? value : refuse("groupId", value))

/** A Maven artifact id: lowercase words joined by `-`. */
export const validateArtifactId = (value: string): string =>
	ARTIFACT_ID.test(value) ? value : refuse("artifactId", value)

/** A package: dotted lowercase identifiers, none a keyword, not under `java` or `javax`. */
export function validatePackageName(value: string): string {
	const segments = value.split(".")
	const valid = segments.every((segment) => SEGMENT.test(segment) && !RESERVED.includes(segment))
	return valid && segments[0] !== "java" && segments[0] !== "javax" ? value : refuse("packageName", value)
}

/** A client class name: PascalCase, and none of the types its own file spells. */
export const validateClientName = (value: string): string =>
	CLIENT_NAME.test(value) && !SPELLED.includes(value) ? value : refuse("clientName", value)

/** A SemVer 2 version. */
export const validateVersion = (value: string): string => (SEMVER.test(value) ? value : refuse("version", value))

/** What Maven Central requires of a POM beyond its name and description, each part the caller gave, validated. */
export type JavaPomMetadata = {
	/** the POM's description, over the document's */
	readonly description?: string
	/** the project's https home page, the POM's `url` */
	readonly homepage?: string
	/** one SPDX license id */
	readonly license?: string
	/** the https URL of its git repository, without a trailing `/` or `.git` */
	readonly repository?: string
	/** `Name <email>` */
	readonly developer?: string
}

/* a repository is a path on its host: `https://host/owner/name` */
const REPOSITORY_PATH = /^https:\/\/[^/]+\/[^/]/

/**
 * The metadata options, each validated; the repository's trailing `/` and `.git` dropped, as the scm block adds `.git`
 * to its connections and shows the rest as its web URL.
 */
function pomMetadata(options: JavaPomMetadata): JavaPomMetadata {
	const repository = checked("repository", options.repository, HTTPS_URL)
	return {
		description: checked("description", options.description, TEXT),
		developer: checked("developer", options.developer, PERSON),
		homepage: checked("homepage", options.homepage, HTTPS_URL),
		license: checked("license", options.license, SPDX_ID),
		repository: checked("repository", repository, REPOSITORY_PATH)
			?.replace(/\/+$/, "")
			.replace(/\.git$/, ""),
	}
}

/** The POM's words: the document's name and description (spec text, written only through `groovyString`), the rest. */
export type JavaPom = JavaPomMetadata & { readonly name?: string }

/** The POM for `options` over the document's `info`: the metadata validated, its description over the document's. */
export function pomOf(
	options: JavaPomMetadata,
	info: { readonly title?: string; readonly description?: string },
): JavaPom {
	const metadata = pomMetadata(options)
	return { ...metadata, description: metadata.description ?? info.description, name: info.title }
}

/**
 * `text` as a single-quoted Groovy string: Java's escapes (Groovy reads the same ones) and the apostrophe's, so spec
 * text neither interpolates (no `$` in `'…'`) nor ends the string.
 */
const groovyString = (text: string) => `'${escapeText(text, "java").replaceAll("'", "\\'")}'`

/* the indent of the `pom { … }` block's members, and of one level in */
const POM = "                "
const IN = "    "

/** `key = '…'` lines at `indent`, each value a Groovy string. */
const assignments = (indent: string, entries: readonly (readonly [key: string, value: string])[]) =>
	entries.map(([key, value]) => `${indent}${key} = ${groovyString(value)}\n`).join("")

/** A `key { … }` block at `indent` around `body`. */
const nested = (indent: string, key: string, body: string) => `${indent}${key} {\n${body}${indent}}\n`

/** The POM's url, license, developer and scm lines, each only when its option was given. */
function pomMetadataLines(pom: JavaPomMetadata): string {
	const developer = pom.developer === undefined ? undefined : personOf(pom.developer)
	const member = (key: string, entries: readonly (readonly [key: string, value: string])[]) =>
		nested(POM + IN, key, assignments(POM + IN + IN, entries))
	const connection = `scm:git:${pom.repository}.git`
	return [
		pom.homepage === undefined ? "" : assignments(POM, [["url", pom.homepage]]),
		pom.license === undefined
			? ""
			: nested(
					POM,
					"licenses",
					member("license", [
						["name", pom.license],
						["url", `https://spdx.org/licenses/${pom.license}.html`],
					]),
				),
		developer === undefined
			? ""
			: nested(
					POM,
					"developers",
					member("developer", [
						["name", developer.name],
						["email", developer.email],
					]),
				),
		pom.repository === undefined
			? ""
			: nested(
					POM,
					"scm",
					assignments(POM + IN, [
						["url", pom.repository],
						["connection", connection],
						["developerConnection", connection],
					]),
				),
	].join("")
}

/**
 * The `build.gradle`: the coordinates, `--release 17` under `-Xlint:all -Werror`, Maven Central, Jackson, and the
 * publication Maven Central takes: `maven-publish`'s `mavenJava` from the Java component with its sources and javadoc
 * jars, its POM named and described by the document (the artifact id and the name when it has none), with the URL,
 * license, developer and scm the options give. Javadoc fails on every doclint finding but a missing comment (C#'s doc
 * build waives CS1591 alone); signing is the publisher's.
 */
export const buildGradle = (pkg: JavaPackage, pom: JavaPom): string => {
	const name = pom.name ?? pkg.artifactId
	const metadata = pomMetadataLines(pom)
	return `plugins {
    id 'java-library'
    id 'maven-publish'
}

group = '${pkg.groupId}'
version = '${pkg.version}'

java {
    withSourcesJar()
    withJavadocJar()
}

tasks.withType(JavaCompile).configureEach {
    options.release = 17
    options.compilerArgs += ['-Xlint:all', '-Werror']
}

tasks.withType(Javadoc).configureEach {
    options.addBooleanOption('Xdoclint:all,-missing', true)
    options.addBooleanOption('Werror', true)
}

repositories {
    mavenCentral()
}

dependencies {
    api '${JACKSON}'
}

publishing {
    publications {
        mavenJava(MavenPublication) {
            from components.java
            pom {
                name = ${groovyString(name)}
                description = ${groovyString(pom.description ?? name)}
${metadata}            }
        }
    }
}
`
}

/** The `settings.gradle`: the artifact id as the root project's name. */
export const settingsGradle = (pkg: JavaPackage): string => `rootProject.name = '${pkg.artifactId}'\n`
