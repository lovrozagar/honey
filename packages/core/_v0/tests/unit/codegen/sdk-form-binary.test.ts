import { describe, expect, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

const ok = { content: { "application/json": { schema: { properties: { ok: { type: "boolean" } }, type: "object" } } } }

function spec(content: Record<string, unknown>) {
	return {
		info: { title: "Test", version: "1.0" },
		openapi: "3.1.0" as const,
		paths: {
			"/upload": {
				put: { operationId: "files.upload", requestBody: { content, required: true }, responses: { "200": ok } },
			},
		},
	}
}

const binaryField = { file: { contentEncoding: "binary", format: "binary", type: "string" } }

describe("SDK input types for binary fields", () => {
	it("a multipart file part is a Blob, so a File can be passed without a cast", () => {
		const { files } = generateSDK(
			spec({ "multipart/form-data": { schema: { properties: binaryField, required: ["file"], type: "object" } } }),
			{ name: "TestSDK" },
		)
		expect(files.types).toContain("form: { file: Blob }")
	})

	it("a list of file parts is a Blob array", () => {
		const { files } = generateSDK(
			spec({
				"multipart/form-data": {
					schema: {
						properties: { files: { items: binaryField.file, type: "array" } },
						required: ["files"],
						type: "object",
					},
				},
			}),
			{ name: "TestSDK" },
		)
		expect(files.types).toContain("form: { files: Blob[] }")
	})

	it("binary inside a JSON body stays a string", () => {
		const { files } = generateSDK(
			spec({ "application/json": { schema: { properties: binaryField, required: ["file"], type: "object" } } }),
			{ name: "TestSDK" },
		)
		expect(files.types).toContain("json: { file: string }")
	})
})
