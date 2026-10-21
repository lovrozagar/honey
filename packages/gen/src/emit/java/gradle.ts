/**
 * The Java package's build and its option rules (bit 16 phase a, D3, D4): a Gradle `java-library` build compiled
 * `--release 17` with `-Xlint:all -Werror`, Maven Central, and the one Jackson 3 dependency; no toolchain block, since
 * auto-provisioning would fetch, and no wrapper, a binary the consumer's own Gradle 9 replaces. Every name the build
 * and the sources spell comes from a validated option, never from spec text.
 */

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

/** The `build.gradle`: the coordinates, `--release 17` under `-Xlint:all -Werror`, Maven Central, Jackson. */
export const buildGradle = (pkg: JavaPackage): string => `plugins {
    id 'java-library'
}

group = '${pkg.groupId}'
version = '${pkg.version}'

tasks.withType(JavaCompile).configureEach {
    options.release = 17
    options.compilerArgs += ['-Xlint:all', '-Werror']
}

repositories {
    mavenCentral()
}

dependencies {
    api '${JACKSON}'
}
`

/** The `settings.gradle`: the artifact id as the root project's name. */
export const settingsGradle = (pkg: JavaPackage): string => `rootProject.name = '${pkg.artifactId}'\n`
