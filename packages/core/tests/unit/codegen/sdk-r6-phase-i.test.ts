import { describe, expect, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

/* ── shared fixture builder ── */

function makeSpec(paths: Record<string, Record<string, Record<string, unknown>>>) {
	return {
		info: { title: "Test", version: "1.0" },
		openapi: "3.1.0" as const,
		paths,
	}
}

const responseSchemaA = {
	properties: { id: { type: "string" }, name: { type: "string" } },
	type: "object",
}

const errEnvelope400 = {
	properties: {
		message: { type: "string" },
		status: { enum: [400] },
		success: { const: false },
	},
}

const errorsStd = {
	"400": { content: { "application/json": { schema: errEnvelope400 } } },
}

/*
 * Phase I fixture — covers all 5 issues:
 * - items: standard HTTP GET (baseline, #R6-25)
 * - ws-resource: WebSocket action (#R6-21 _ws debug property)
 * - state: resource named "state" to exercise #R6-22 collision
 * - projects/{id}: path param resource (#R6-22 outer proxy)
 * - nullable/tuple schemas embedded in responses (#R6-25)
 */
/* eslint-disable sort-keys -- intentional fixture ordering */
const phaseISpec = makeSpec({
	"/v1/items": {
		get: {
			operationId: "items.list",
			responses: {
				"200": { content: { "application/json": { schema: responseSchemaA } } },
				...errorsStd,
			},
		},
	},
	"/v1/ws-resource": {
		get: {
			operationId: "ws-resource.connect",
			responses: { "200": { content: { "application/json": { schema: responseSchemaA } } } },
			"x-websocket": true,
		},
	},
	"/v1/state": {
		get: {
			operationId: "state.list",
			responses: {
				"200": { content: { "application/json": { schema: responseSchemaA } } },
				...errorsStd,
			},
		},
	},
	"/v1/projects/{project_id}": {
		get: {
			operationId: "project.get",
			responses: {
				"200": { content: { "application/json": { schema: responseSchemaA } } },
				...errorsStd,
			},
		},
	},
	"/v1/nullable-string": {
		get: {
			operationId: "nullableString.get",
			responses: {
				"200": {
					content: {
						"application/json": {
							schema: { type: "string", nullable: true },
						},
					},
				},
			},
		},
	},
	"/v1/nullable-number": {
		get: {
			operationId: "nullableNumber.get",
			responses: {
				"200": {
					content: {
						"application/json": {
							schema: { type: "number", nullable: true },
						},
					},
				},
			},
		},
	},
	"/v1/nullable-boolean": {
		get: {
			operationId: "nullableBoolean.get",
			responses: {
				"200": {
					content: {
						"application/json": {
							schema: { type: "boolean", nullable: true },
						},
					},
				},
			},
		},
	},
	"/v1/type-array": {
		get: {
			operationId: "typeArray.get",
			responses: {
				"200": {
					content: {
						"application/json": {
							schema: { type: ["string", "null"] },
						},
					},
				},
			},
		},
	},
	"/v1/tuple": {
		get: {
			operationId: "tuple.get",
			responses: {
				"200": {
					content: {
						"application/json": {
							schema: {
								items: [{ type: "string" }, { type: "number" }],
								type: "array",
							},
						},
					},
				},
			},
		},
	},
	"/v1/addl-props": {
		get: {
			operationId: "addlProps.get",
			responses: {
				"200": {
					content: {
						"application/json": {
							schema: {
								additionalProperties: { type: "number" },
								properties: { a: { type: "string" } },
							},
						},
					},
				},
			},
		},
	},
	"/v1/nullable-array": {
		get: {
			operationId: "nullableArray.get",
			responses: {
				"200": {
					content: {
						"application/json": {
							schema: { items: { type: "string" }, nullable: true, type: "array" },
						},
					},
				},
			},
		},
	},
	"/v1/nullable-object": {
		get: {
			operationId: "nullableObject.get",
			responses: {
				"200": {
					content: {
						"application/json": {
							schema: { nullable: true, properties: { x: { type: "number" } }, type: "object" },
						},
					},
				},
			},
		},
	},
})
/* eslint-enable sort-keys */

/* ═══════════════════════════════════════════════════════════════════
   #R6-25 — jsonSchemaToTS emitter (via generateSDK round-trip)
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-25 jsonSchemaToTS — Layer A invariants", () => {
	it("Layer A: { type: 'string' } emits string in files.types", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(files.types).toContain("string")
	})

	it("Layer A: { type: 'integer' } schema emits number in return types", () => {
		const spec = makeSpec({
			"/v1/num": {
				get: {
					operationId: "num.get",
					responses: {
						"200": { content: { "application/json": { schema: { type: "integer" } } } },
					},
				},
			},
		})
		const { files } = generateSDK(spec, { name: "TestSDK" })
		expect(files.types).toContain("number")
	})

	it("Layer A: { type: 'array' } with no items emits unknown[] in files.types", () => {
		const spec = makeSpec({
			"/v1/arr": {
				get: {
					operationId: "arr.get",
					responses: {
						"200": { content: { "application/json": { schema: { type: "array" } } } },
					},
				},
			},
		})
		const { files } = generateSDK(spec, { name: "TestSDK" })
		expect(files.types).toContain("unknown[]")
	})

	it("Layer A: generating from same spec twice produces byte-identical files.types", () => {
		const { files: a } = generateSDK(phaseISpec, { name: "TestSDK" })
		const { files: b } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(a.types).toBe(b.types)
	})

	it("Layer A: generating from same spec twice produces byte-identical files.client", () => {
		const { files: a } = generateSDK(phaseISpec, { name: "TestSDK" })
		const { files: b } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(a.client).toBe(b.client)
	})
})

describe("#R6-25 jsonSchemaToTS — Layer B' regression", () => {
	it("Layer B' post-fix: { type: 'string', nullable: true } emits string | null", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		const idx = files.types.indexOf("nullableString:")
		expect(idx).toBeGreaterThan(-1)
		const block = files.types.slice(idx, idx + 300)
		expect(block).toContain("string | null")
	})

	it("Layer B' post-fix: { type: ['string', 'null'] } emits string | null", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		const idx = files.types.indexOf("typeArray:")
		expect(idx).toBeGreaterThan(-1)
		const block = files.types.slice(idx, idx + 300)
		expect(block).toContain("string | null")
	})

	it("Layer B' post-fix: tuple items array emits [string, number]", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		const idx = files.types.indexOf("tuple:")
		expect(idx).toBeGreaterThan(-1)
		const block = files.types.slice(idx, idx + 300)
		expect(block).toContain("[string, number]")
	})

	it("Layer B' post-fix: additionalProperties emits [k: string]: number alongside named props", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		const idx = files.types.indexOf("addlProps:")
		expect(idx).toBeGreaterThan(-1)
		const block = files.types.slice(idx, idx + 300)
		expect(block).toContain("[k: string]: number")
		expect(block).toContain("a?:")
	})

	it("Layer B' post-fix: { type: 'number', nullable: true } emits number | null", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		const idx = files.types.indexOf("nullableNumber:")
		expect(idx).toBeGreaterThan(-1)
		const block = files.types.slice(idx, idx + 300)
		expect(block).toContain("number | null")
	})

	it("Layer B' post-fix: { type: 'boolean', nullable: true } emits boolean | null", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		const idx = files.types.indexOf("nullableBoolean:")
		expect(idx).toBeGreaterThan(-1)
		const block = files.types.slice(idx, idx + 300)
		expect(block).toContain("boolean | null")
	})

	it("Layer B' post-fix: { type: 'array', items: string, nullable: true } emits string[] | null", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		const idx = files.types.indexOf("nullableArray:")
		expect(idx).toBeGreaterThan(-1)
		const block = files.types.slice(idx, idx + 300)
		expect(block).toContain("string[] | null")
	})

	it("Layer B' post-fix: { type: 'object', properties: { x: number }, nullable: true } emits { x?: number } | null", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		const idx = files.types.indexOf("nullableObject:")
		expect(idx).toBeGreaterThan(-1)
		const block = files.types.slice(idx, idx + 300)
		expect(block).toContain("| null")
		expect(block).toContain("x?:")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-22 — interface state member + outer proxy service-map-first
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-22 interface state + proxy — Layer B' regression", () => {
	it("Layer B' post-fix: files.types interface contains 'state: Record<string, unknown>'", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		const interfaceIdx = files.types.indexOf("export interface TestSDK")
		expect(interfaceIdx).toBeGreaterThan(-1)
		const interfaceBlock = files.types.slice(interfaceIdx, interfaceIdx + 600)
		expect(interfaceBlock).toContain("state: Record<string, unknown>")
	})

	it("Layer B' post-fix: files.client outer proxy checks typeof resourceName === 'symbol' first", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(files.client).toContain(`typeof resourceName === "symbol"`)
	})

	it("Layer B' post-fix: files.client outer proxy does NOT use 'resourceName in target' guard", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(files.client).not.toContain("resourceName in target")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-21 — WS _ws debug property
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-21 WS _ws property — Layer B' regression", () => {
	it("Layer B' post-fix: files.client contains Object.defineProperty(typed, '_ws', ...) on WS result", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(files.client).toContain(`Object.defineProperty(typed, "_ws", { enumerable: false, value: ws })`)
	})

	it("Layer B' post-fix: files.client WS method ends with 'return typed' not inline object literal", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(files.client).toContain("return typed")
		expect(files.client).not.toContain(
			"return { close, off, on, get readyState() { return ws.readyState }, send }",
		)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-24 — Date/Symbol in #serializeSearch + form-urlencoded
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-24 Date/Symbol serialize — Layer B' regression", () => {
	it("Layer B' post-fix: #serializeSearch contains instanceof Date check", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(files.client).toContain("instanceof Date")
	})

	it("Layer B' post-fix: #serializeSearch contains toISOString() call for Date values", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(files.client).toContain("toISOString()")
	})

	it("Layer B' post-fix: #serializeSearch contains typeof v === 'symbol' check", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(files.client).toContain(`typeof v === "symbol"`)
	})

	it("Layer B' post-fix: form-urlencoded path also contains instanceof Date check", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		/* The form-urlencoded branch is after #serializeSearch — both must be fixed */
		const serializeIdx = files.client.indexOf("#serializeSearch")
		const formIdx = files.client.indexOf(`"application/x-www-form-urlencoded"`)
		expect(formIdx).toBeGreaterThan(-1)
		const formBlock = files.client.slice(formIdx, formIdx + 500)
		expect(serializeIdx).toBeGreaterThan(-1)
		expect(formBlock).toContain("instanceof Date")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-23 — dispose() method
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-23 dispose — Layer B' regression", () => {
	it("Layer B' post-fix: files.client contains #disposeCtrl = new AbortController()", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(files.client).toContain("#disposeCtrl = new AbortController()")
	})

	it("Layer B' post-fix: files.client contains #disposed = false field", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(files.client).toContain("#disposed = false")
	})

	it("Layer B' post-fix: files.client contains dispose(): void method", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(files.client).toContain("dispose(): void {")
	})

	it("Layer B' post-fix: files.client dispose() calls this.#disposeCtrl.abort()", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(files.client).toContain("this.#disposeCtrl.abort()")
	})

	it("Layer B' post-fix: files.client #buildSignal composes this.#disposeCtrl.signal", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		expect(files.client).toContain("this.#disposeCtrl.signal")
	})

	it("Layer B' post-fix: files.types interface contains dispose(): void", () => {
		const { files } = generateSDK(phaseISpec, { name: "TestSDK" })
		const interfaceIdx = files.types.indexOf("export interface TestSDK")
		expect(interfaceIdx).toBeGreaterThan(-1)
		const interfaceBlock = files.types.slice(interfaceIdx, interfaceIdx + 600)
		expect(interfaceBlock).toContain("dispose(): void")
	})
})
