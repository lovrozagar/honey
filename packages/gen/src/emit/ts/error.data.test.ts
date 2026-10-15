import { Project, ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import { generateSdk } from "./sdk.ts"

/** honey's error envelope for `status`, its `error_key` one of `keys`, as a JSON response. */
function envelopeResponse(status: number, keys: string[]) {
	const field = {
		properties: { error_key: { type: "string" }, message: { type: "string" }, path: { type: "string" } },
		required: ["error_key", "message", "path"],
		type: "object",
	}
	const schema = {
		properties: {
			error_key: { enum: keys, type: "string" },
			fields: { additionalProperties: { items: field, type: "array" }, type: "object" },
			message: { type: "string" },
			status: { enum: [status], type: "integer" },
			status_key: { type: "string" },
			success: { const: false, type: "boolean" },
		},
		required: ["error_key", "fields", "message", "status", "status_key", "success"],
		type: "object",
	}
	return { content: { "application/json": { schema } }, description: `error ${status}` }
}

/** `GET /a` and `GET /b` (`res.a`, `res.b`), each declaring the same 400, 404 and 500 envelopes. */
const errorsFor = () => ({
	"200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" },
	"400": envelopeResponse(400, ["bad_request", "validation_error"]),
	"404": envelopeResponse(404, ["not_found"]),
	"500": envelopeResponse(500, ["internal_error"]),
})
const DOC = {
	info: { title: "Test", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/a": { get: { operationId: "res.a", responses: errorsFor() } },
		"/b": { get: { operationId: "res.b", responses: errorsFor() } },
	},
}

/** The type errors of `probe` checked strictly against the files `generateSdk(DOC)` emits, as `line: message`. */
function typeErrors(probe: string): string[] {
	const { files, stem } = generateSdk(DOC, { name: "TestSDK" })
	const project = new Project({
		compilerOptions: {
			allowImportingTsExtensions: true,
			lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			noEmit: true,
			strict: true,
			target: ts.ScriptTarget.ESNext,
			types: [],
		},
		useInMemoryFileSystem: true,
	})
	for (const [name, text] of Object.entries(files)) project.createSourceFile(`/sdk/${name}`, text)
	const file = project.createSourceFile("/sdk/probe.ts", probe.replaceAll("$INDEX", `./${stem}.index.gen.ts`))
	return file
		.getPreEmitDiagnostics()
		.map((d) => `${d.getLineNumber() ?? 0}: ${ts.flattenDiagnosticMessageText(d.compilerObject.messageText, " ")}`)
}

describe("typed error data: a safe-mode error narrowed by its status", () => {
	// v0: c4252688b9
	it("keeps each declared status and its error_key literals, in every method sharing the shape", () => {
		const probe = `import { TestSDK } from "$INDEX"
export async function probe(sdk: TestSDK): Promise<void> {
	for (const result of [await sdk.res.a(), await sdk.res.b()]) {
		if (result.error === null) continue
		if (result.status === 400) {
			const key: "bad_request" | "validation_error" = result.error.error_key
			const status: 400 = result.error.status
			// @ts-expect-error a 400 never carries a 404 key
			const wrong: "not_found" = result.error.error_key
		}
		if (result.status === 404) {
			const key: "not_found" = result.error.error_key
		}
		if (result.status === 500) {
			const key: "internal_error" = result.error.error_key
		}
		// @ts-expect-error 418 is no declared status
		if (result.status === 418) continue
	}
}
`
		expect(typeErrors(probe)).toEqual([])
	})

	// v0: f2954af53b
	it("types each fields entry flat as { error_key, message, path }, with no nested fields", () => {
		const probe = `import { TestSDK } from "$INDEX"
export async function probe(sdk: TestSDK): Promise<void> {
	const result = await sdk.res.a()
	if (result.error === null || result.status !== 400) return
	const entry = result.error.fields["name"]?.[0]
	if (entry === undefined) return
	const flat: { error_key: string; message: string; path: string } = entry
	// @ts-expect-error a field entry carries no nested fields
	entry.fields
}
`
		expect(typeErrors(probe)).toEqual([])
	})
})
