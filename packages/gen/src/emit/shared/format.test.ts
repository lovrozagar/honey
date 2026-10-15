import { format } from "oxfmt"
import { describe, expect, it } from "vitest"
import { generateAppClient } from "../ts/app-client.ts"
import { generateSdk } from "../ts/sdk.ts"
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
