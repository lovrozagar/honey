import { describe, expect, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

/* ── helpers ── */

function makeSpec(paths: Record<string, Record<string, Record<string, unknown>>>) {
	return {
		info: { title: "Test", version: "1.0" },
		openapi: "3.1.0" as const,
		paths,
	}
}

function assertBalancedBrackets(types: string): void {
	let braces = 0
	let angles = 0
	let parens = 0
	let brackets = 0

	for (const ch of types) {
		if (ch === "{") braces++
		else if (ch === "}") braces--
		else if (ch === "<") angles++
		else if (ch === ">") angles--
		else if (ch === "(") parens++
		else if (ch === ")") parens--
		else if (ch === "[") brackets++
		else if (ch === "]") brackets--
	}

	expect(braces).toBe(0)
	expect(angles).toBe(0)
	expect(parens).toBe(0)
	expect(brackets).toBe(0)
}

/* shared spec fixture for #1 tests */
const inputSuffixSpec = makeSpec({
	"/items": {
		get: {
			operationId: "items.list",
			responses: { "200": { content: { "application/json": { schema: { type: "array" } } } } },
		},
	},
	"/items/{id}": {
		post: {
			operationId: "items.create",
			requestBody: {
				content: {
					"application/json": {
						schema: {
							properties: { name: { type: "string" } },
							required: ["name"],
							type: "object",
						},
					},
				},
			},
			responses: { "201": { content: { "application/json": { schema: { type: "object" } } } } },
		},
	},
	"/stream": {
		get: {
			operationId: "events.stream",
			responses: {
				"200": { content: { "text/event-stream": { schema: { type: "string" } } } },
			},
		},
	},
	"/ws": {
		get: {
			operationId: "ws.connect",
			responses: { "200": {} },
			"x-websocket": true,
		},
	},
})

/* ═══════════════════════════════════════════════════════════════════
   #1 — Input-type suffix fields
   ═══════════════════════════════════════════════════════════════════ */

describe("#1 input-type suffix — signal, headers, cookies", () => {
	it("HTTP method input type includes signal?: AbortSignal", () => {
		const { files } = generateSDK(inputSuffixSpec, { name: "TestSDK" })
		expect(files.types).toContain("signal?: AbortSignal")
	})

	it("HTTP method input type includes headers?: Record<string, string> on a method line", () => {
		const { files } = generateSDK(inputSuffixSpec, { name: "TestSDK" })
		/*
		 * headers?: Record<string, string> already exists in the config type as part of a union,
		 * but NOT on a method's own input type line. After the fix, every method input
		 * must carry it as a standalone optional field — assert it appears on a
		 * line that also contains a method call signature (i.e. "(input").
		 */
		const methodInputLine = files.types
			.split("\n")
			.find((l) => l.includes("(input") && l.includes("headers?: Record<string, string>"))
		expect(methodInputLine).toBeDefined()
	})

	it("HTTP method input type includes cookies?: Record<string, string>", () => {
		const { files } = generateSDK(inputSuffixSpec, { name: "TestSDK" })
		expect(files.types).toContain("cookies?: Record<string, string>")
	})

	it("SSE method input type includes lastEventId?: string", () => {
		const { files } = generateSDK(inputSuffixSpec, { name: "TestSDK" })
		expect(files.types).toContain("lastEventId?: string")
	})

	it("WS method input type includes protocols?: string | string[]", () => {
		const { files } = generateSDK(inputSuffixSpec, { name: "TestSDK" })
		expect(files.types).toContain("protocols?: string | string[]")
	})

	it("WS method input type includes reconnectToken?: string", () => {
		const { files } = generateSDK(inputSuffixSpec, { name: "TestSDK" })
		expect(files.types).toContain("reconnectToken?: string")
	})

	it("param-less GET emits input?: { not input: {", () => {
		/* /items GET has no params, no body, no search — must be optional arg */
		const { files } = generateSDK(inputSuffixSpec, { name: "TestSDK" })
		/* The list method should use optional input */
		expect(files.types).toContain("input?: {")
		/* must NOT have a required input for the param-less GET */
		const listLine = files.types
			.split("\n")
			.find((l) => l.includes("list("))
		expect(listLine).toBeDefined()
		expect(listLine).not.toMatch(/list\(input: \{/)
	})

	it("balanced brackets in files.types after input suffix additions", () => {
		const { files } = generateSDK(inputSuffixSpec, { name: "TestSDK" })
		/*
		 * assertBalancedBrackets counts raw < and > characters. TypeScript function
		 * types using => (e.g. handler: () => void) contribute an extra > that
		 * never has a matching <. Strip lines containing => before the structural
		 * check so the angle-bracket count is meaningful.
		 */
		const stripped = files.types.split("\n").filter((l) => !l.includes("=>")).join("\n")
		assertBalancedBrackets(stripped)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #2 emitter-string — 204 invalidation (HTTP 2xx gate, superseded by Phase F #R6-3)
   ═══════════════════════════════════════════════════════════════════ */

describe("#2 204 invalidation — emitter string", () => {
	it("files.client gates safe-branch invalidation on HTTP 2xx status (not on parse success)", () => {
		const { files } = generateSDK(makeSpec({
			"/v1/users": {
				get: { operationId: "users.list", responses: {} },
				post: {
					operationId: "users.create",
					responses: {},
					"x-invalidate": ["GET /v1/users"],
				},
			},
		}), { name: "TestSDK" })

		/* Phase F #R6-3 replaces the R4 `r.error === null` gate with an HTTP 2xx status check,
		   so parse errors on otherwise-successful responses no longer skip invalidation. */
		expect(files.client).toContain("r.status >= 200 && r.status < 300")
		expect(files.client).not.toContain("r.data !== null")
		expect(files.client).not.toContain("r.error === null")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #3 — Types file size / dedupe
   ═══════════════════════════════════════════════════════════════════ */

function makeErrResponse(statusCode: number, keys: string[]) {
	return {
		content: {
			"application/json": {
				schema: {
					properties: {
						error_key: { enum: keys, type: "string" },
						fields: {
							additionalProperties: { items: { type: "object" }, type: "array" },
							type: "object",
						},
						message: { type: "string" },
						status: { enum: [statusCode], type: "integer" },
						status_key: { type: "string" },
						success: { const: false, type: "boolean" },
					},
					required: ["error_key", "fields", "message", "status", "status_key", "success"],
					type: "object",
				},
			},
		},
	}
}

const dedupeSpec = makeSpec({
	"/a": {
		get: {
			operationId: "res.a",
			responses: {
				"200": { content: { "application/json": { schema: { type: "object" } } } },
				"400": makeErrResponse(400, ["bad_request", "validation_error"]),
				"404": makeErrResponse(404, ["not_found"]),
				"500": makeErrResponse(500, ["internal_error"]),
			},
		},
	},
	"/b": {
		get: {
			operationId: "res.b",
			responses: {
				"200": { content: { "application/json": { schema: { type: "object" } } } },
				"400": makeErrResponse(400, ["bad_request", "validation_error"]),
				"404": makeErrResponse(404, ["not_found"]),
				"500": makeErrResponse(500, ["internal_error"]),
			},
		},
	},
	"/c": {
		get: {
			operationId: "res.c",
			responses: {
				"200": { content: { "application/json": { schema: { type: "object" } } } },
				"400": makeErrResponse(400, ["bad_request", "validation_error"]),
				"404": makeErrResponse(404, ["not_found"]),
				"500": makeErrResponse(500, ["internal_error"]),
			},
		},
	},
	"/d": {
		get: {
			operationId: "res.d",
			responses: {
				"200": { content: { "application/json": { schema: { type: "object" } } } },
				"400": makeErrResponse(400, ["bad_request", "validation_error"]),
				"404": makeErrResponse(404, ["not_found"]),
				"500": makeErrResponse(500, ["internal_error"]),
			},
		},
	},
	"/e": {
		get: {
			operationId: "res.e",
			responses: {
				"200": { content: { "application/json": { schema: { type: "object" } } } },
				"400": makeErrResponse(400, ["bad_request", "validation_error"]),
				"404": makeErrResponse(404, ["not_found"]),
				"500": makeErrResponse(500, ["internal_error"]),
			},
		},
	},
})

describe("#3 types file dedupe — _ErrEnvelope alias", () => {
	it("files.types contains type _ErrEnvelope< declaration", () => {
		const { files } = generateSDK(dedupeSpec, { name: "TestSDK" })
		expect(files.types).toContain("type _ErrEnvelope<")
	})

	it("files.types contains type _ErrField = declaration", () => {
		const { files } = generateSDK(dedupeSpec, { name: "TestSDK" })
		expect(files.types).toContain("type _ErrField =")
	})

	it("error_key: string; fields: Record<string substring does not appear (R5-1 flattened _ErrField)", () => {
		const { files } = generateSDK(dedupeSpec, { name: "TestSDK" })
		/*
		 * Phase A characterized the buggy `_ErrField` alias where the inner
		 * row shape declared a recursive `fields` key. R5-1 flattened that
		 * alias to `{ error_key; message; path }`, so the substring no
		 * longer appears anywhere in the types file.
		 */
		const needle = "error_key: string; fields: Record<string"
		const count = files.types.split(needle).length - 1
		expect(count).toBe(0)
	})

	it("deduped types still reference 400, 404, 500 and original error_key literals for method a", () => {
		const { files } = generateSDK(dedupeSpec, { name: "TestSDK" })
		/* The method type string must still surface status codes and keys */
		expect(files.types).toContain("400")
		expect(files.types).toContain("404")
		expect(files.types).toContain("500")
		expect(files.types).toContain("bad_request")
		expect(files.types).toContain("not_found")
		expect(files.types).toContain("internal_error")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #4 — Binary / non-JSON response types
   ═══════════════════════════════════════════════════════════════════ */

const responseTypeSpec = makeSpec({
	"/binary": {
		get: {
			operationId: "files.binary",
			responses: {
				"200": { content: { "application/octet-stream": {} } },
			},
		},
	},
	"/csv": {
		get: {
			operationId: "files.csv",
			responses: {
				"200": { content: { "text/csv": {} } },
			},
		},
	},
	"/noContent": {
		delete: {
			operationId: "items.delete",
			responses: { "204": {} },
		},
	},
	"/pdf": {
		get: {
			operationId: "files.pdf",
			responses: {
				"200": { content: { "application/pdf": {} } },
			},
		},
	},
	"/text": {
		get: {
			operationId: "files.text",
			responses: {
				"200": { content: { "text/plain": {} } },
			},
		},
	},
})

describe("#4 binary / non-JSON response types", () => {
	it("application/octet-stream response type is SDKResult<ArrayBuffer", () => {
		const { files } = generateSDK(responseTypeSpec, { name: "TestSDK" })
		/* binary method must contain ArrayBuffer in return type */
		const binaryLine = files.types
			.split("\n")
			.find((l) => l.includes("binary("))
		expect(binaryLine).toBeDefined()
		expect(binaryLine).toContain("SDKResult<ArrayBuffer")
	})

	it("text/csv response type is SDKResult<string", () => {
		const { files } = generateSDK(responseTypeSpec, { name: "TestSDK" })
		const csvLine = files.types
			.split("\n")
			.find((l) => l.includes("csv("))
		expect(csvLine).toBeDefined()
		expect(csvLine).toContain("SDKResult<string")
	})

	it("text/plain response type is SDKResult<string", () => {
		const { files } = generateSDK(responseTypeSpec, { name: "TestSDK" })
		const textLine = files.types
			.split("\n")
			.find((l) => l.includes("text("))
		expect(textLine).toBeDefined()
		expect(textLine).toContain("SDKResult<string")
	})

	it("204 no-content response type is SDKResult<null not SDKResult<void", () => {
		const { files } = generateSDK(responseTypeSpec, { name: "TestSDK" })
		const deleteLine = files.types
			.split("\n")
			.find((l) => l.includes("delete("))
		expect(deleteLine).toBeDefined()
		expect(deleteLine).toContain("SDKResult<null")
		expect(deleteLine).not.toContain("SDKResult<void")
	})

	it("application/pdf (unknown content-type) falls back to SDKResult<ArrayBuffer", () => {
		const { files } = generateSDK(responseTypeSpec, { name: "TestSDK" })
		const pdfLine = files.types
			.split("\n")
			.find((l) => l.includes("pdf("))
		expect(pdfLine).toBeDefined()
		expect(pdfLine).toContain("SDKResult<ArrayBuffer")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #5 — Config mutation guard (constructor shallow-clone)
   ═══════════════════════════════════════════════════════════════════ */

describe("#5 config mutation — constructor emits shallow clone", () => {
	it("files.client does NOT contain this.#config.state = this.state", () => {
		const { files } = generateSDK(makeSpec({
			"/users": { get: { operationId: "users.list", responses: {} } },
		}), { name: "TestSDK" })
		expect(files.client).not.toContain("this.#config.state = this.state")
	})

	it("files.client constructor contains shallow-clone pattern { ...config, state:", () => {
		const { files } = generateSDK(makeSpec({
			"/users": { get: { operationId: "users.list", responses: {} } },
		}), { name: "TestSDK" })
		expect(files.client).toContain("{ ...config, state:")
	})

	it("files.client constructor contains const ownState = config.state ?? {}", () => {
		const { files } = generateSDK(makeSpec({
			"/users": { get: { operationId: "users.list", responses: {} } },
		}), { name: "TestSDK" })
		expect(files.client).toContain("const ownState = config.state ?? {}")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #6 — String escaping in generated types
   ═══════════════════════════════════════════════════════════════════ */

describe("#6 string escaping — const with embedded double-quotes", () => {
	it("const schema value with embedded double-quotes is JSON.stringify-escaped", () => {
		const spec = makeSpec({
			"/greet": {
				get: {
					operationId: "greet.say",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: { const: 'say "hi"' },
								},
							},
						},
					},
				},
			},
		})
		const { files } = generateSDK(spec, { name: "TestSDK" })
		/* JSON.stringify('say "hi"') === '"say \\"hi\\""' */
		expect(files.types).toContain('"say \\"hi\\""')
		/* must NOT contain unescaped embedded quotes */
		expect(files.types).not.toContain('"say "hi""')
	})

	it("enum strings with backslash and newline are JSON.stringify-escaped", () => {
		const spec = makeSpec({
			"/items": {
				get: {
					operationId: "items.list",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: { enum: ["a\\b", "c\nd"], type: "string" },
								},
							},
						},
					},
				},
			},
		})
		const { files } = generateSDK(spec, { name: "TestSDK" })
		/* JSON.stringify("a\\b") === '"a\\\\b"' (one real backslash → two in JSON) */
		expect(files.types).toContain('"a\\\\b"')
		/* JSON.stringify("c\nd") === '"c\\nd"' */
		expect(files.types).toContain('"c\\nd"')
	})

	it("object property key with embedded double-quote is JSON.stringify-escaped", () => {
		const spec = makeSpec({
			"/items": {
				get: {
					operationId: "items.obj",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { 'foo"bar': { type: "string" } },
										type: "object",
									},
								},
							},
						},
					},
				},
			},
		})
		const { files } = generateSDK(spec, { name: "TestSDK" })
		/*
		 * The fixture schema has no required array, so the property is optional.
		 * Assert the key is correctly escaped regardless of optionality —
		 * both "foo\"bar": (required) and "foo\"bar"?: (optional) are valid.
		 */
		expect(files.types).toContain('"foo\\"bar"')
	})

	it("path containing special chars uses JSON.stringify form in files.map", () => {
		const spec = makeSpec({
			"/items/{weird-name}": {
				get: {
					operationId: "items.get",
					responses: {},
				},
			},
		})
		const { files } = generateSDK(spec, { name: "TestSDK" })
		/* JSON.stringify("/items/{weird-name}") === '"/items/{weird-name}"' —
		   the key point is the emitter uses JSON.stringify not bare template,
		   so we assert the path value is double-quoted correctly in the map */
		expect(files.map).toContain('path: "/items/{weird-name}"')
	})

	it("assertBalancedBrackets passes on pathological string fixtures", () => {
		const spec = makeSpec({
			"/greet": {
				get: {
					operationId: "greet.say",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: { const: 'say "hi"' },
								},
							},
						},
					},
				},
			},
			"/items": {
				get: {
					operationId: "items.list",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: { enum: ["a\\b", "c\nd"], type: "string" },
								},
							},
						},
					},
				},
			},
		})
		const { files } = generateSDK(spec, { name: "TestSDK" })
		/*
		 * Strip lines containing => before the structural check — TypeScript function
		 * types (e.g. handler: () => void, retry: () => Promise<...>) contribute
		 * an unmatched > that the naive character-count algorithm cannot handle.
		 */
		const stripped = files.types.split("\n").filter((l) => !l.includes("=>")).join("\n")
		assertBalancedBrackets(stripped)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #24 — Error message log hygiene
   ═══════════════════════════════════════════════════════════════════ */

describe("#24 error message hygiene — #parseAsClientError emits safe message", () => {
	it("files.client #parseAsClientError contains .slice(0, 512) truncation", () => {
		const { files } = generateSDK(makeSpec({
			"/users": { get: { operationId: "users.list", responses: {} } },
		}), { name: "TestSDK" })
		expect(files.client).toContain(".slice(0, 512)")
	})

	it("files.client #parseAsClientError contains control-char strip regex [\\x00-\\x1f]", () => {
		const { files } = generateSDK(makeSpec({
			"/users": { get: { operationId: "users.list", responses: {} } },
		}), { name: "TestSDK" })
		/*
		 * The emitted source will contain the literal characters \x00-\x1f
		 * as a regex character class. In the JS string we look for the
		 * backslash-x sequence exactly as it appears in the generated source.
		 */
		expect(files.client).toContain("[\\x00-\\x1f]")
	})

	it("files.client #parseAsClientError still passes body into new _ClientError({ body,", () => {
		const { files } = generateSDK(makeSpec({
			"/users": { get: { operationId: "users.list", responses: {} } },
		}), { name: "TestSDK" })
		expect(files.client).toContain("body,")
		/* body must appear inside the _ClientError constructor call */
		const clientErrorIdx = files.client.indexOf("new _ClientError({")
		expect(clientErrorIdx).toBeGreaterThan(-1)
		const snippet = files.client.slice(clientErrorIdx, clientErrorIdx + 300)
		expect(snippet).toContain("body,")
	})
})
