import { format } from "oxfmt"
import { describe, expect, it } from "vitest"
import { generateAppClient } from "../ts/app-client.ts"
import { generateSdk } from "../ts/sdk.ts"
import { longNames } from "./__fixtures__/documents-long.ts"
import { EMIT_STYLE, type Formatter, formatFiles } from "./format.ts"

const JSON_OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "" } }
const DOC = {
	components: { schemas: { User: { properties: { id: { type: "string" } }, required: ["id"], type: "object" } } },
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/users/{id}": {
			get: {
				operationId: "users.get",
				parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
				responses: JSON_OK,
			},
		},
	},
}

/** The SDK and app-client files, as the emitters write them. */
const emitted = () => ({ ...generateSdk(DOC, { name: "TestSDK" }).files, ...generateAppClient().files })

describe("formatFiles: the emit post-pass (F4)", () => {
	it("leaves every emitted TS file oxfmt-clean when oxfmt is passed: formatting again changes nothing", async () => {
		const formatted = await formatFiles(emitted(), { ts: format })
		const again = await formatFiles(formatted, { ts: format })
		expect(Object.keys(formatted).sort()).toEqual(Object.keys(emitted()).sort())
		expect(again).toEqual(formatted)
	})

	// bit 21 i7a: red-first clean
	it("leaves the long-name SDK oxfmt-clean in every file, the safe mirror's types too: formatting again changes nothing", async () => {
		const files = generateSdk(longNames(), { name: "LongSDK" }).files
		const reached: string[] = []
		const counting: Formatter = (name, source, options) => {
			reached.push(name)
			return format(name, source, options)
		}
		const formatted = await formatFiles(files, { ts: counting })
		/* not vacuous: the pass reaches every file, and the types (the safe mirror's among them) and the map run past 120 */
		const long = (name: string) => (files[name] ?? "").split("\n").filter((line) => line.length > 120).length
		expect({
			pastWidth: ["long-sdk.map.gen.ts", "long-sdk.types.gen.ts"].filter((name) => long(name) > 0),
			reached: reached.sort(),
			safe: /^export type LongSDKSafe = /m.test(files["long-sdk.types.gen.ts"] ?? ""),
		}).toEqual({
			pastWidth: ["long-sdk.map.gen.ts", "long-sdk.types.gen.ts"],
			reached: Object.keys(files).sort(),
			safe: true,
		})
		expect(await formatFiles(formatted, { ts: format })).toEqual(formatted)
	})

	it("passes the files through as emitted, a copy, when no formatter resolves", async () => {
		const files = emitted()
		const out = await formatFiles(files, {})
		expect([out, out === files]).toEqual([files, false])
	})

	it("formats each file by its extension's formatter, in honey's style, and leaves any other file as it is", async () => {
		const seen: unknown[] = []
		const formatter: Formatter = async (name, source, options) => {
			seen.push([name, options])
			return { code: source.trim(), errors: [] }
		}
		const out = await formatFiles({ "a.ts": " x \n", "README.md": " y \n", toString: " z " }, { ts: formatter })
		expect([out, seen]).toEqual([{ "a.ts": "x", "README.md": " y \n", toString: " z " }, [["a.ts", EMIT_STYLE]]])
	})

	it("refuses a file the formatter cannot parse, naming it", async () => {
		await expect(formatFiles({ "bad.ts": "const = 1\n" }, { ts: format })).rejects.toThrow(/could not format bad\.ts/)
	})
})
