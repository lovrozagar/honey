import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { formatFiles } from "../shared/format.ts"
import { gofmtFormatter } from "../shared/gofmt.ts"
import { type Compiled, compileGo } from "./__fixtures__/compiled.ts"
import { GO_FLOOR, gofmtPath, withGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()

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
	it("goes out as emitted without a gofmt", async () => {
		const files = generateGoSdk(DOCUMENT).files
		expect(await formatFiles(files, {})).toEqual(files)
	})

	// v0: 3c1d480aa1
	it.skipIf(!GO)(
		"leaves gofmt -l nothing to list after the gofmt pass, and builds as emitted without one",
		async () => {
			const files = generateGoSdk(DOCUMENT).files
			const raw = compileGo(files)
			const sdk = await formattedSdk()
			const listed = spawnSync(gofmtPath(), ["-l", sdk.dir], { encoding: "utf8" })
			expect(
				{ listed: listed.stdout, rawBuilds: raw.built, status: listed.status },
				raw.stderr + listed.stderr,
			).toEqual({
				listed: "",
				rawBuilds: true,
				status: 0,
			})
		},
		600_000,
	)

	// v0: fa5233feff
	it.skipIf(!GO)(
		"builds under the pinned toolchain",
		async () => {
			const sdk = await formattedSdk()
			expect(sdk.built, sdk.stderr).toBe(true)
		},
		600_000,
	)

	// v0: f0f9e64b26
	it.skipIf(!GO)(
		"is go vet clean under the pinned toolchain, which holds it to the go 1.24 floor",
		async () => {
			const sdk = await formattedSdk()
			expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
		},
		600_000,
	)
})

describe("the emitted Go SDK under the go 1.24 floor toolchain", () => {
	it("declares the floor GO_FLOOR names and ships every runtime file", () => {
		const files = generateGoSdk(DOCUMENT).files
		const runtime = readdirSync(new URL("../../runtime/go/", import.meta.url)).filter((name) => name.endsWith(".go"))
		expect({
			floor: files["go.mod"]?.includes(`\ngo ${GO_FLOOR.split(".").slice(0, 2).join(".")}\n`),
			missing: runtime.filter((name) => !(name in files)),
		}).toEqual({ floor: true, missing: [] })
	})

	it.skipIf(!GO)(
		"builds and vets clean under the GO_FLOOR toolchain itself",
		() => {
			const files = generateGoSdk(DOCUMENT).files
			const floor = compileGo(files, { toolchain: GO_FLOOR })
			expect({ built: floor.built, vet: floor.vet }, floor.stderr).toEqual({ built: true, vet: [] })
		},
		600_000,
	)

	it.skipIf(!GO)(
		"compiles under the toolchain it is given, in a cache dir of its own: a module past the floor fails there",
		() => {
			const [major, minor, patch] = GO_FLOOR.split(".")
			const past = {
				"go.mod": `module example.com/past\n\ngo ${major}.${minor}.${Number(patch) + 1}\n`,
				"past.go": "package past\n",
			}
			const pinned = compileGo(past)
			const floor = compileGo(past, { toolchain: GO_FLOOR })
			expect({ floor: floor.built, ownDir: floor.dir !== pinned.dir, pinned: pinned.built, why: floor.stderr }).toEqual(
				{
					floor: false,
					ownDir: true,
					pinned: true,
					why: expect.stringContaining(`requires go >= ${major}.${minor}.${Number(patch) + 1} (running go ${GO_FLOOR}`),
				},
			)
		},
		600_000,
	)
})
