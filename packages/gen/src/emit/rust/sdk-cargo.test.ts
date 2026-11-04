/**
 * `cargoToml`'s `[package]` metadata (bit 22 a): what crates.io reads, each line only when the caller gave it.
 * `cargo publish` refuses a crate with no description and no license, so a generated crate that declares neither
 * publishes nowhere — the emitter takes them as options and writes nothing it was not given. Plan 39 8.6: each value
 * is checked against the grammar every target shares and crates.io's own limits (five keywords of at most 20 ASCII
 * characters, five category slugs), `documentation` and `categories` join them, and an `include` allow-list keeps
 * what is written beside the crate out of what cargo packs, as the pinned cargo lists it.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"
import { MANIFEST } from "../../gen/write.ts"
import { generated } from "../../index.ts"
import { written } from "../mcp/__fixtures__/written.ts"
import { runCargo, withRust } from "./__fixtures__/rust-env.ts"
import { generateRustSdk } from "./sdk.ts"

type Json = Record<string, unknown>

const minimal: Json = {
	info: { title: "Acme", version: "1" },
	openapi: "3.1.0",
	paths: { "/ping": { get: { responses: { "200": { description: "ok" } } } } },
}

/** Cargo.toml's `[package]` table, read line by line (the emitter writes one key per line). */
function pkg(options = {}): Record<string, unknown> {
	const text = generateRustSdk(minimal, options).files["Cargo.toml"] ?? ""
	const table: Record<string, unknown> = {}
	for (const line of text.split("\n")) {
		if (line === "[lib]" || line === "[dependencies]") break
		const pair = /^([A-Za-z-]+) = (.+)$/.exec(line)
		if (pair !== null) table[pair[1] as string] = JSON.parse(pair[2] as string)
	}
	return table
}

describe("the crate's [package] metadata", () => {
	it("writes the crate metadata it is given, nothing for what it is not, and splits the CLI's keywords", () => {
		expect({
			bare: Object.keys(pkg()).sort(),
			full: pkg({
				description: "The Acme API.",
				homepage: "https://acme.example",
				keywords: "acme, api ,,",
				license: "MIT",
				repository: "https://github.com/acme/sdk-rust",
			}),
		}).toEqual({
			bare: ["edition", "include", "name", "rust-version", "version"],
			full: {
				description: "The Acme API.",
				edition: "2024",
				include: ["/src"],
				homepage: "https://acme.example",
				keywords: ["acme", "api"],
				license: "MIT",
				name: "honey-sdk",
				repository: "https://github.com/acme/sdk-rust",
				"rust-version": "1.85",
				version: "0.1.0",
			},
		})
	})
	it.each([
		[
			["acme", "api"],
			["acme", "api"],
		],
		[[], undefined],
		["", undefined],
	])("takes the keywords %j as %j", (keywords, kept) => {
		expect(pkg({ keywords }).keywords).toEqual(kept)
	})
})

describe("the crate's metadata as crates.io takes it (plan 39 8.6)", () => {
	it("writes documentation and categories, and fills documentation from the run's metadata block", async () => {
		const run = await generated(
			{
				metadata: { documentation: "https://docs.acme.example" },
				options: { rust: { categories: "api-bindings, web-programming::http-client" } },
				targets: ["rust"],
			},
			minimal,
			{ env: {}, report: () => undefined },
		)
		const text = run.rust?.["Cargo.toml"] ?? ""
		expect([/^documentation = .*$/m.exec(text)?.[0], /^categories = .*$/m.exec(text)?.[0]]).toEqual([
			'documentation = "https://docs.acme.example"',
			'categories = ["api-bindings", "web-programming::http-client"]',
		])
	})

	it.each([
		["keywords", "acme,an-api-keyword-of-21c"],
		["keywords", "acme,über"],
		["keywords", "acme,-api"],
		["keywords", "a,b,c,d,e,f"],
		["categories", "API Bindings"],
		["categories", "a,b,c,d,e,f"],
		["description", "two\nlines"],
		["documentation", "http://docs.acme.example"],
		["homepage", "acme.example"],
		["repository", "git@github.com:acme/sdk.git"],
		["license", "MIT or Apache-2.0"],
	])("refuses %s %j before it reaches Cargo.toml, naming the option", (option, value) => {
		expect(() => generateRustSdk(minimal, { [option]: value })).toThrow(`Invalid ${option}: `)
	})

	it("takes five keywords of 20 characters, a + and a _ among them", () => {
		expect(pkg({ keywords: "a1,b_2,c+3,d-4,keyword-of-20-chars" }).keywords).toEqual([
			"a1",
			"b_2",
			"c+3",
			"d-4",
			"keyword-of-20-chars",
		])
	})
})

describe.skipIf(!withRust())("the crate cargo packs (plan 39 8.6)", () => {
	it(
		"holds the sources, the manifest and the lock, and nothing written beside them",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const dir = written(generateRustSdk(minimal, { description: "The Acme API.", license: "MIT" }).files)
			writeFileSync(join(dir, MANIFEST), "{}\n")
			writeFileSync(join(dir, "notes.txt"), "kept out\n")
			const listed = runCargo(["package", "--list", "--allow-dirty", "--offline"], { cwd: dir })
			const files = listed.stdout.split("\n").filter(Boolean)
			expect([listed.status, files.filter((file) => !file.startsWith("src/"))], listed.stderr).toEqual([
				0,
				["Cargo.lock", "Cargo.toml", "Cargo.toml.orig"],
			])
		},
	)
})
