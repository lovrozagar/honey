/**
 * The Java SDK's Gradle build (bit 16 phase a, D3, D4): each option's default, effect and refusal, in the table shape
 * `sdk.test.ts`'s C# options use, through `generateJavaSdk`, whose validators live in `gradle.ts`. The build declares
 * the one Jackson dependency, compiles `--release 17` with `-Xlint:all -Werror`, takes Maven Central only, applies
 * the `java-library` plugin only, and holds no Gradle wrapper and no toolchain block: auto-provisioning would fetch,
 * and the consumer brings Gradle 9.
 */
import { describe, expect, it } from "vitest"
import { generateJavaSdk, type JavaSdkOptions } from "./sdk.ts"

type Json = Record<string, unknown>
type Files = Readonly<Record<string, string>>

/** The zero-op document: no path, so no operation. */
const ZERO: Json = { info: { title: "Anyrow", version: "1" }, openapi: "3.1.0", paths: {} }

const filesOf = (options?: JavaSdkOptions): Files => generateJavaSdk(ZERO, options).files

/** The coordinates, the source paths and the top-level class names read back from `files`. */
const summary = (files: Files) => ({
	artifact: /^rootProject\.name = '([^']*)'$/m.exec(files["settings.gradle"] ?? "")?.[1],
	classes: Object.values(files).flatMap((text) =>
		[...text.matchAll(/^(?:public )?final class (\w+)/gm)].map((m) => m[1]),
	),
	group: /^group = '([^']*)'$/m.exec(files["build.gradle"] ?? "")?.[1],
	sources: Object.keys(files)
		.filter((name) => name.endsWith(".java"))
		.map((name) => name.replace(/^src\/main\/java\//, "")),
	version: /^version = '([^']*)'$/m.exec(files["build.gradle"] ?? "")?.[1],
})

/** The trimmed, non-empty lines of the top-level block `name { … }` in `build.gradle`. */
const block = (files: Files, name: string): string[] =>
	(files["build.gradle"] ?? "")
		.split(`${name} {`)[1]
		?.split("\n}")[0]
		?.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "") ?? []

describe("generateJavaSdk: the defaults (D4)", () => {
	it("defaults to group ai.anyrow, artifact anyrow, version 0.1.0, the package ai.anyrow and the client AnyrowClient", () => {
		expect(summary(filesOf())).toEqual({
			artifact: "anyrow",
			classes: ["AnyrowClient", "Transport"],
			group: "ai.anyrow",
			sources: ["ai/anyrow/AnyrowClient.java", "ai/anyrow/Transport.java"],
			version: "0.1.0",
		})
	})

	it("derives the client from the package's last segment, capitalizing its first letter only", () => {
		expect(summary(filesOf({ packageName: "com.acme.billing" })).classes).toEqual(["BillingClient", "Transport"])
	})
})

describe("generateJavaSdk: the options' effects (D4)", () => {
	it("takes groupId into the build's group", () => {
		expect(summary(filesOf({ groupId: "com.acme" })).group).toBe("com.acme")
	})

	it("takes artifactId into the settings' root project name", () => {
		expect(summary(filesOf({ artifactId: "acme-sdk" })).artifact).toBe("acme-sdk")
	})

	it("takes version into the build's version", () => {
		expect(summary(filesOf({ version: "2.0.0-rc.1" })).version).toBe("2.0.0-rc.1")
	})

	it("takes packageName into every source's path and package line", () => {
		const files = filesOf({ packageName: "com.acme.sdk" })
		expect({
			packages: Object.values(files).flatMap((text) => text.match(/^package .*;$/gm) ?? []),
			sources: summary(files).sources,
		}).toEqual({
			packages: ["package com.acme.sdk;", "package com.acme.sdk;"],
			sources: ["com/acme/sdk/SdkClient.java", "com/acme/sdk/Transport.java"],
		})
	})

	it("takes clientName into the client's class and its file name", () => {
		const files = filesOf({ clientName: "AcmeClient" })
		expect({ classes: summary(files).classes, sources: summary(files).sources }).toEqual({
			classes: ["AcmeClient", "Transport"],
			sources: ["ai/anyrow/AcmeClient.java", "ai/anyrow/Transport.java"],
		})
	})
})

describe("generateJavaSdk: the options' refusals (D4)", () => {
	it.each([
		["groupId", "Ai.anyrow"],
		["groupId", "ai..anyrow"],
		["groupId", "ai.any row"],
		["groupId", "1ai"],
		["artifactId", "Anyrow"],
		["artifactId", "anyrow-"],
		["artifactId", "any row"],
		["artifactId", "a'b"],
		["packageName", "class"],
		["packageName", "ai.class"],
		["packageName", "ai._"],
		["packageName", "ai.2x"],
		["packageName", "Ai.x"],
		["packageName", "java.util"],
		["packageName", "javax.x"],
		["clientName", "lower"],
		["clientName", "Any-Client"],
		["clientName", "String"],
		["clientName", "Transport"],
		["clientName", "URI"],
		["version", "1.0"],
		["version", "01.0.0"],
		["version", "1.0.0-"],
		["version", "v1.0.0"],
	] as const)("refuses the %s %j, naming it", (option, value) => {
		expect(() => generateJavaSdk(ZERO, { [option]: value })).toThrow(`Invalid ${option}: "${value}"`)
	})

	it("refuses as clientName every type the emitted client file imports, so a class never clashes with its import", () => {
		const client = generateJavaSdk(ZERO).files["src/main/java/ai/anyrow/AnyrowClient.java"] ?? ""
		const imported = [...client.matchAll(/^import [\w.]+\.(\w+);$/gm)].map((match) => match[1] as string)
		expect(imported.length).toBeGreaterThan(0)
		for (const name of imported) expect(() => generateJavaSdk(ZERO, { clientName: name })).toThrow(`Invalid clientName`)
	})

	it.each([
		["packageName", "ai.anyrow_v2"],
		["clientName", "My_apiClient"],
		["version", "1.2.3+build.7"],
	] as const)("takes the %s %j, a legal value the refusals must not cover", (option, value) => {
		expect(() => generateJavaSdk(ZERO, { [option]: value })).not.toThrow()
	})
})

describe("generateJavaSdk: the build's shape (D3)", () => {
	it("declares the one Jackson dependency, as api, at 3.2.4", () => {
		expect(block(filesOf(), "dependencies")).toEqual(["api 'tools.jackson.core:jackson-databind:3.2.4'"])
	})

	/* phase f item 6 adds maven-publish: the build publishes to Maven Central (gradle.publish.test.ts) */
	it("applies the java-library and maven-publish plugins only", () => {
		expect(block(filesOf(), "plugins")).toEqual(["id 'java-library'", "id 'maven-publish'"])
	})

	it("compiles --release 17 with -Xlint:all and -Werror", () => {
		const build = filesOf()["build.gradle"] ?? ""
		expect(build).toContain("options.release = 17")
		expect(build).toContain("options.compilerArgs += ['-Xlint:all', '-Werror']")
	})

	it("takes Maven Central and no other repository", () => {
		expect(block(filesOf(), "repositories")).toEqual(["mavenCentral()"])
	})

	it("holds no toolchain block, since auto-provisioning would fetch", () => {
		expect(filesOf()["build.gradle"]).not.toMatch(/toolchain/i)
	})

	it("ships no Gradle wrapper: no gradlew, no wrapper properties, no wrapper jar", () => {
		expect(Object.keys(filesOf()).filter((name) => /gradlew|gradle\/wrapper|gradle-wrapper/.test(name))).toEqual([])
	})
})
