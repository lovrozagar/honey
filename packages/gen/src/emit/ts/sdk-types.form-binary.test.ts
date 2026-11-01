/**
 * A multipart form's binary field is a Blob, so a File passes, and it is a Blob whether the body's schema is
 * written inline or behind a `$ref`. One named component cannot be both: the same schema reached from a JSON
 * body is a string there, and emitting the component's *name* for the form is what hid the Blob — the SDK then
 * had no way to upload the file at all.
 */
import { describe, expect, it } from "vitest"
import { generateSdk } from "./sdk.ts"

type Json = Record<string, unknown>

const BINARY = { contentEncoding: "binary", format: "binary", type: "string" }
const SHAPE = { properties: { file: BINARY, text: { type: "string" } }, type: "object" }
const form = (schema: Json) => ({ content: { "multipart/form-data": { schema } }, required: true })
const jsonBody = (schema: Json) => ({ content: { "application/json": { schema } }, required: true })

/** The emitted types text of a one-operation document. */
function typesOf(paths: Json, schemas?: Json): string {
	const document: Json = { info: { title: "T", version: "1" }, openapi: "3.1.0", paths }
	if (schemas) document.components = { schemas }
	const { files, stem } = generateSdk(document, { name: "T" })
	return files[`${stem}.types.gen.ts`] ?? ""
}

const op = (requestBody: Json) => ({
	"/upload": { post: { operationId: "upload.create", requestBody, responses: { 200: { description: "ok" } } } },
})

describe("a multipart form's binary field", () => {
	it("is a Blob when the form's schema is written inline", () => {
		expect(typesOf(op(form(SHAPE)))).toContain("form: { file?: Blob; text?: string }")
	})

	it("is a Blob when the form's schema is a $ref to a component", () => {
		const text = typesOf(op(form({ $ref: "#/components/schemas/UploadRequest" })), { UploadRequest: SHAPE })
		expect(text).toContain("form: { file?: Blob; text?: string }")
	})

	it("stays a string on the component itself, which a JSON body reads", () => {
		const paths = {
			...op(form({ $ref: "#/components/schemas/UploadRequest" })),
			"/describe": {
				post: {
					operationId: "describe.create",
					requestBody: jsonBody({ $ref: "#/components/schemas/UploadRequest" }),
					responses: { 200: { description: "ok" } },
				},
			},
		}
		const text = typesOf(paths, { UploadRequest: SHAPE })
		expect(text).toContain("export type UploadRequest = { file?: string; text?: string }")
		expect(text).toContain("json: UploadRequest")
		expect(text).toContain("form: { file?: Blob; text?: string }")
	})
})
