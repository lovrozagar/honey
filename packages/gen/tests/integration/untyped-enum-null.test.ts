/**
 * An untyped enum holding a null (bit 19 c, sweep item 5) reads as the nullable literal union its values spell, so
 * every SDK types it exactly as it types the `type`-tagged form: the IR, which every emitter reads alone (H2), makes
 * the two one schema. Before, the untyped form was `unknown` and every target emitted its top type (Python `Any`, Go
 * `json.RawMessage`, Rust `serde_json::Value`, TS `unknown`, C# `JsonElement`, Java `JsonNode`).
 */
import { describe, expect, it } from "vitest"
import { generateCSharpSdk } from "../../src/emit/csharp/sdk.ts"
import { generateGoSdk } from "../../src/emit/go/sdk.ts"
import { generateJavaSdk } from "../../src/emit/java/sdk.ts"
import { generatePythonSdk } from "../../src/emit/python/sdk.ts"
import { generateRustSdk } from "../../src/emit/rust/sdk.ts"
import { generateSdk } from "../../src/emit/ts/sdk.ts"

/** A GET answering `{ status }` whose `status` is `schema`. */
const doc = (schema: Record<string, unknown>) => ({
	components: { schemas: { Item: { properties: { status: schema }, required: ["status"], type: "object" } } },
	info: { title: "Enum", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/item": {
			get: {
				operationId: "item.get",
				responses: {
					200: {
						content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } },
						description: "ok",
					},
				},
			},
		},
	},
})

const UNTYPED = doc({ enum: ["active", "closed", null] })
const TYPED = doc({ enum: ["active", "closed", null], type: ["string", "null"] })

/** Each target's emitted files for `document`, by name. */
const TARGETS: readonly (readonly [string, (document: Record<string, unknown>) => Readonly<Record<string, string>>])[] =
	[
		["ts", (document) => generateSdk(document, { name: "EnumSDK" }).files],
		["go", (document) => generateGoSdk(document, { modulePath: "example.com/enum" }).files],
		["rust", (document) => generateRustSdk(document).files],
		["python", (document) => generatePythonSdk(document).files],
		["csharp", (document) => generateCSharpSdk(document).files],
		["java", (document) => generateJavaSdk(document, { packageName: "com.example.enumsdk" }).files],
	]

describe("an untyped enum holding a null, in every SDK (bit 19 c)", () => {
	it.each(TARGETS)("%s: emits every file exactly as for the type-tagged nullable enum", (_target, generate) => {
		const untyped = generate(UNTYPED)
		const typed = generate(TYPED)
		const differing = Object.keys({ ...untyped, ...typed }).filter((name) => untyped[name] !== typed[name])
		expect(differing).toEqual([])
	})
})
