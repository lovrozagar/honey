/**
 * `cargoToml`'s `[package]` metadata (bit 22 a): what crates.io reads, each line only when the caller gave it.
 * `cargo publish` refuses a crate with no description and no license, so a generated crate that declares neither
 * publishes nowhere — the emitter takes them as options and writes nothing it was not given.
 */
import { describe, expect, it } from "vitest"
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
			bare: ["edition", "name", "rust-version", "version"],
			full: {
				description: "The Acme API.",
				edition: "2024",
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
	])("takes the keywords %j as %j", (keywords, written) => {
		expect(pkg({ keywords }).keywords).toEqual(written)
	})
})
