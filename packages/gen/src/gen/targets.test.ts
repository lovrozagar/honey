/**
 * The targets and their options schemas (plan 39 8.1), read through the package entry as a consumer does: `TARGETS`
 * is what `--target` accepts, each schema takes every option the CLI parses for its target and refuses what the CLI
 * would, and `generated` holds a run passed as data to the same schemas.
 */
import { describe, expect, expectTypeOf, it } from "vitest"
import { generated, type GenerateRun, type TargetOptions, TARGETS, targetOptionSchemas } from "../index.ts"
import { parseGenerate, usage } from "./args.ts"

/** What a schema makes of `value`: the value it accepts, or its issues' messages and paths. */
function validated(target: (typeof TARGETS)[number], value: unknown) {
	const result = targetOptionSchemas[target]["~standard"].validate(value)
	return result.issues === undefined
		? { value: result.value }
		: { issues: result.issues.map(({ message, path }) => ({ message, path })) }
}

const USAGE = usage()

/** Every option the CLI parses for `target`: a run that sets each `--<target>-<option>` its usage lists, parsed. */
function cliOptions(target: (typeof TARGETS)[number]): Record<string, string> {
	const argv = ["--spec", "spec.json", "--out", "out", "--target", target]
	for (const [, flag] of USAGE.matchAll(new RegExp(`--${target}-([a-z-]+)`, "g")))
		argv.push(`--${target}-${flag}=${flag === "aur" || flag === "tanstack-query" ? "true" : "x"}`)
	return { ...parseGenerate(argv).options[target] }
}

describe("TARGETS (plan 39 8.1)", () => {
	it("is exactly what --target accepts, in the order usage lists them", () => {
		const listed = /--target <name> {3}(.*?); repeat/.exec(USAGE)?.[1]?.split(", ")
		expect([TARGETS, listed]).toEqual([listed, [...TARGETS]])
		for (const target of TARGETS)
			expect(parseGenerate(["--spec", "s.json", "--out", "o", "--target", target]).targets).toEqual([target])
	})
})

describe("targetOptionSchemas (plan 39 8.1)", () => {
	it("is a Standard Schema per target that accepts every option the CLI parses for it", () => {
		for (const target of TARGETS) {
			const options = cliOptions(target)
			expect([target, Object.keys(options).length > 0]).toEqual([target, true])
			expect(validated(target, options)).toEqual({ value: options })
			expect(targetOptionSchemas[target]["~standard"]).toMatchObject({ vendor: "honey-clients", version: 1 })
		}
		expect(validated("go", {})).toEqual({ value: {} })
	})

	it("refuses an unknown option, an empty or non-string value, a switch that is not true or false, a non-object", () => {
		expect(validated("go", { modulePth: "github.com/a/b" })).toEqual({
			issues: [{ message: 'unknown go option "modulePth": want one of modulePath', path: ["modulePth"] }],
		})
		expect(validated("python", { packageName: "", version: 2 })).toEqual({
			issues: [
				{ message: "python option packageName: want a non-empty string", path: ["packageName"] },
				{ message: "python option version: want a non-empty string", path: ["version"] },
			],
		})
		expect(validated("ts", { name: "Api", tanstackQuery: "yes" })).toEqual({
			issues: [{ message: 'ts option tanstackQuery: want "true" or "false"', path: ["tanstackQuery"] }],
		})
		for (const value of [null, "x", ["modulePath"]])
			expect(validated("go", value)).toEqual({
				issues: [{ message: "go options: want an object of option names to strings", path: undefined }],
			})
	})

	it("types each target's options by its own names, a switch as true or false", () => {
		expectTypeOf<TargetOptions<"go">>().toEqualTypeOf<{ readonly modulePath?: string }>()
		expectTypeOf<TargetOptions<"ts">>().toEqualTypeOf<{
			readonly name?: string
			readonly packageName?: string
			readonly stem?: string
			readonly tanstackQuery?: "true" | "false"
			readonly version?: string
		}>()
		expectTypeOf(targetOptionSchemas.python["~standard"].validate).returns.toExtend<
			{ readonly value: TargetOptions<"python"> } | { readonly issues: readonly unknown[] }
		>()
		// @ts-expect-error: a misspelled option is a type error on a run, not a silent default
		const run: GenerateRun = { options: { go: { modulePth: "github.com/a/b" } }, targets: ["go"] }
		expect(run.targets).toEqual(["go"])
	})
})

describe("generated (plan 39 8.1)", () => {
	it("refuses a run whose options its target's schema refuses, before generating anything", async () => {
		const reported: string[] = []
		const run = { options: { go: { modulePth: "github.com/a/b" } }, targets: ["go"] } as unknown as GenerateRun
		await expect(generated(run, {}, { env: {}, report: (line) => reported.push(line) })).rejects.toThrow(
			'unknown go option "modulePth": want one of modulePath',
		)
		expect(reported).toEqual([])
	})

	it("passes a run's checked options through to its target's generator", async () => {
		const document = { info: { title: "Shop", version: "1" }, openapi: "3.1.0", paths: {} }
		const run: GenerateRun = { options: { java: { packageName: "com.acme.shop" } }, targets: ["java"] }
		const files = await generated(run, document, { env: {}, report: () => undefined })
		expect(Object.keys(files.java ?? {}).filter((path) => path.includes("com/acme/shop/")).length > 0).toBe(true)
	})
})

describe("the run's metadata block (plan 39 8.2)", () => {
	const document = { info: { title: "Shop", version: "1" }, openapi: "3.1.0", paths: {} }
	const metadata = {
		authors: ["Acme Inc <oss@acme.dev>", "Bo"],
		description: "The Shop API's client",
		homepage: "https://acme.dev",
		license: "MIT",
		repository: "https://github.com/acme/shop",
	}
	/** The one file of `files` whose path ends with `suffix`. */
	const fileEnding = (files: Readonly<Record<string, string>> | undefined, suffix: string) =>
		Object.entries(files ?? {}).find(([path]) => path.endsWith(suffix))?.[1] ?? ""

	it("fills each target's options of the same meaning, the target's own option winning", async () => {
		const run: GenerateRun = {
			metadata,
			options: { java: { description: "The Shop API for the JVM" } },
			targets: ["csharp", "java"],
		}
		const files = await generated(run, document, { env: {}, report: () => undefined })
		const csproj = fileEnding(files.csharp, ".csproj")
		expect(
			["Description", "Authors", "PackageLicenseExpression", "PackageProjectUrl", "RepositoryUrl"].map(
				(element) => new RegExp(`<${element}>(.*)</${element}>`).exec(csproj)?.[1],
			),
		).toEqual(["The Shop API%27s client", "Acme Inc, Bo", "MIT", "https://acme.dev", "https://github.com/acme/shop"])
		const gradle = fileEnding(files.java, "build.gradle")
		expect(
			[
				"description = 'The Shop API for the JVM'",
				"url = 'https://acme.dev'",
				"name = 'MIT'",
				"name = 'Acme Inc'",
				"email = 'oss@acme.dev'",
				"url = 'https://github.com/acme/shop'",
			].filter((line) => !gradle.includes(line)),
		).toEqual([])
	})

	it("refuses a block a field of which its grammar refuses, before generating anything", async () => {
		const run: GenerateRun = { metadata: { homepage: "http://acme.dev" }, targets: ["csharp"] }
		await expect(generated(run, document, { env: {}, report: () => undefined })).rejects.toThrow(
			'Invalid metadata.homepage: "http://acme.dev"',
		)
		// @ts-expect-error: a misspelled field is a type error on a run
		const misspelled: GenerateRun = { metadata: { licence: "MIT" }, targets: ["csharp"] }
		await expect(generated(misspelled, document, { env: {}, report: () => undefined })).rejects.toThrow(
			'Invalid metadata: unknown field "licence"',
		)
	})

	it("treats an option given as undefined as not given, so the metadata still fills it", async () => {
		const run: GenerateRun = { metadata, options: { csharp: { license: undefined } }, targets: ["csharp"] }
		const files = await generated(run, document, { env: {}, report: () => undefined })
		expect(fileEnding(files.csharp, ".csproj")).toContain("<PackageLicenseExpression>MIT</PackageLicenseExpression>")
	})
})
