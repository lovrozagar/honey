import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../routing/app.ts"
import { createComponents } from "./components.ts"
import { generateOpenApi } from "./generate.ts"

const INFO = { title: "T", version: "1" }

/** A schema whose one property refers to a $defs entry named `name`. */
const withDefs = (name: string) => ({
	$defs: { [name]: { type: "string" } },
	properties: { x: { $ref: `#/$defs/${name}` } },
})

describe("createComponents: a converter's local references lifted into components", () => {
	it("hands a schema with nothing local back as it is", () => {
		const components = createComponents()
		const schema = { properties: { a: { type: "string" } }, type: "object" }
		expect([components.hoist(schema, "Hint") === schema, components.schemas()]).toEqual([true, {}])
	})

	it("lifts $defs and definitions under their names, rewrites the refs, and decodes a pointer", () => {
		const components = createComponents()
		const lifted = components.hoist(
			{
				$defs: { "a/b": { type: "string" }, Node: { properties: { next: { $ref: "#/$defs/Node" } }, type: "object" } },
				definitions: { Legacy: { type: "number" } },
				properties: {
					legacy: { $ref: "#/definitions/Legacy" },
					node: { $ref: "#/$defs/Node" },
					slash: { $ref: "#/$defs/a~1b" },
				},
				type: "object",
			},
			"Body",
		)
		expect([lifted, components.schemas()]).toEqual([
			{
				properties: {
					legacy: { $ref: "#/components/schemas/Legacy" },
					node: { $ref: "#/components/schemas/Node" },
					slash: { $ref: "#/components/schemas/a_b" },
				},
				type: "object",
			},
			{
				Legacy: { type: "number" },
				Node: { properties: { next: { $ref: "#/components/schemas/Node" } }, type: "object" },
				a_b: { type: "string" },
			},
		])
	})
})

describe("createComponents: a converter's local references lifted into components", () => {
	it("lifts a root that refers to itself under the hint, and names a converter's __schema defs after it", () => {
		const components = createComponents()
		const lifted = components.hoist(
			{
				$defs: { __schema0: { properties: { up: { $ref: "#" } }, type: "object" } },
				properties: { child: { $ref: "#/$defs/__schema0" }, name: { type: "string" } },
				type: "object",
			},
			"Category",
		)
		expect([lifted, components.schemas()]).toEqual([
			{ $ref: "#/components/schemas/Category" },
			{
				Category: {
					properties: { child: { $ref: "#/components/schemas/Category0" }, name: { type: "string" } },
					type: "object",
				},
				Category0: { properties: { up: { $ref: "#/components/schemas/Category" } }, type: "object" },
			},
		])
	})

	it("suffixes a name already taken, by this document or by the caller, and never touches a $ref inside data", () => {
		const components = createComponents((name) => name === "Taken")
		const first = components.hoist(withDefs("Taken"), "A")
		const second = components.hoist(withDefs("Taken"), "B")
		const data = components.hoist(
			{ $defs: { D: { type: "string" } }, default: { $ref: "#/$defs/D" }, examples: [{ $ref: "#" }], properties: {} },
			"C",
		)
		expect([first, second, data, Object.keys(components.schemas())]).toEqual([
			{ properties: { x: { $ref: "#/components/schemas/Taken2" } } },
			{ properties: { x: { $ref: "#/components/schemas/Taken3" } } },
			{ default: { $ref: "#/$defs/D" }, examples: [{ $ref: "#" }], properties: {} },
			["Taken2", "Taken3", "D"],
		])
	})

	it("names a component Schema when its name sanitizes to nothing", () => {
		const components = createComponents()
		components.hoist({ $defs: { "***": { type: "string" } }, properties: { x: { $ref: "#/$defs/***" } } }, "H")
		expect(Object.keys(components.schemas())).toEqual(["Schema"])
	})
})

describe("components in the document", () => {
	// v0: a33af6318e

	it("points a recursive schema's self-reference at its component, never at the document root", () => {
		const Category = z.object({
			name: z.string(),
			get subcategories() {
				return z.array(Category)
			},
		})
		const app = honey<{}>()
		app
			.get("/categories")
			.output({ "application/json": { ok: Category } })
			.handler((c) => c.res.json("ok", { name: "a", subcategories: [] }))
		const doc = generateOpenApi(app, { info: INFO })
		const text = JSON.stringify(doc)
		const schemas = doc.components?.schemas ?? {}
		const [name] = Object.keys(schemas).filter((n) => JSON.stringify(schemas[n]).includes("subcategories"))
		expect([text.includes('"$ref":"#"'), text.includes("$defs"), name !== undefined]).toEqual([false, false, true])
		expect(JSON.stringify(schemas[name as string])).toContain(`"$ref":"#/components/schemas/${name}"`)
	})
})

describe("createComponents: references it does not own", () => {
	it("keeps a reference outside its own defs as written, and reads a property named $ref as a schema", () => {
		const components = createComponents()
		const out = components.hoist(
			{
				$defs: { Tag: { type: "string" } },
				properties: {
					$ref: { items: { $ref: "#" }, type: "array" },
					away: { $ref: "https://example.com/s.json" },
					gone: { $ref: "#/$defs/Missing" },
					tag: { $ref: "#/$defs/Tag" },
				},
				type: "object",
			},
			"Node",
		)
		expect([out, components.schemas()]).toEqual([
			{ $ref: "#/components/schemas/Node" },
			{
				Node: {
					properties: {
						$ref: { items: { $ref: "#/components/schemas/Node" }, type: "array" },
						away: { $ref: "https://example.com/s.json" },
						gone: { $ref: "#/$defs/Missing" },
						tag: { $ref: "#/components/schemas/Tag" },
					},
					type: "object",
				},
				Tag: { type: "string" },
			},
		])
	})
})
