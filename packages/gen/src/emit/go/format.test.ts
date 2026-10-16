import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { formatFiles } from "../shared/format.ts"
import { gofmtFormatter } from "../shared/gofmt.ts"
import { type Compiled, compileGo } from "./__fixtures__/compiled.ts"
import { gofmtPath, withGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"

type Json = Record<string, unknown>

const STRING = { type: "string" }
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: Json) => ({ content: { "application/json": { schema } } })
const ok = (schema: Json) => ({ 200: { ...json(schema), description: "ok" } })
const events = (schema: Json) => ({ 200: { content: { "text/event-stream": { schema } }, description: "events" } })

/** An API reaching every emitted file: nested namespaces, options, a body, enums, nullables, a WebSocket, typed and string SSE, realtime. */
const DOCUMENT: Json = {
	components: {
		schemas: {
			Pet: {
				description: "A pet.\nIt may have */ in its prose.",
				properties: {
					id: STRING,
					kind: { enum: ["cat", "dog"], type: "string" },
					owner: { anyOf: [ref("Pet"), { type: "null" }] },
					tags: { additionalProperties: STRING, type: "object" },
				},
				required: ["id", "kind"],
				type: "object",
			},
			PetInput: { properties: { name: STRING }, required: ["name"], type: "object" },
		},
	},
	info: { description: "Pets, formatted.", title: "Format", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/feed": {
			get: {
				operationId: "feed.live",
				parameters: [{ in: "query", name: "channel", required: true, schema: STRING }],
				responses: events(ref("Pet")),
				"x-realtime": true,
				"x-websocket": true,
			},
		},
		"/live": {
			get: { operationId: "live.subscribe", responses: { 101: { description: "upgrade" } }, "x-websocket": true },
		},
		"/pets/events": { get: { operationId: "pets.events", responses: events(ref("Pet")) } },
		"/pets/log": { get: { operationId: "pets.log", responses: events(STRING) } },
		"/pets": {
			get: {
				operationId: "pets.list",
				parameters: [{ in: "query", name: "kind", schema: STRING }],
				responses: ok({ items: ref("Pet"), type: "array" }),
				summary: "List pets",
			},
			post: {
				operationId: "pets.create",
				requestBody: { ...json(ref("PetInput")), required: true },
				responses: ok(ref("Pet")),
			},
		},
		"/pets/{id}/owner": {
			get: {
				operationId: "pets.owner.get",
				parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
				responses: ok(ref("Pet")),
			},
		},
	},
}

let formatted: Promise<Compiled> | undefined
/** The SDK through the mandatory gofmt pass, written, built and vetted once. */
function formattedSdk(): Promise<Compiled> {
	formatted ??= formatFiles(generateGoSdk(DOCUMENT).files, { go: gofmtFormatter(gofmtPath()) }).then((files) =>
		compileGo(files),
	)
	return formatted
}

describe("the emitted Go SDK through gofmt, build and vet", () => {
	// v0: 3c1d480aa1
	it("leaves gofmt -l nothing to list after the gofmt pass, and goes out as emitted, still valid Go, without a gofmt", async () => {
		const files = generateGoSdk(DOCUMENT).files
		expect(await formatFiles(files, {})).toEqual(files)
		if (!withGo()) return
		const raw = compileGo(files)
		const sdk = await formattedSdk()
		const listed = spawnSync(gofmtPath(), ["-l", sdk.dir], { encoding: "utf8" })
		expect({ listed: listed.stdout, rawBuilds: raw.built, status: listed.status }, raw.stderr + listed.stderr).toEqual({
			listed: "",
			rawBuilds: true,
			status: 0,
		})
	}, 600_000)

	// v0: fa5233feff
	it("builds under the pinned toolchain", async () => {
		if (!withGo()) return
		const sdk = await formattedSdk()
		expect(sdk.built, sdk.stderr).toBe(true)
	}, 600_000)

	// v0: f0f9e64b26
	it("is go vet clean under the pinned toolchain, which holds it to the go 1.24 floor", async () => {
		if (!withGo()) return
		const sdk = await formattedSdk()
		expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
	}, 600_000)
})
