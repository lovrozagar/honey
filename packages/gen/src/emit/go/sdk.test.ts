import { readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { compileGo } from "./__fixtures__/compiled.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"

type Json = Record<string, unknown>
type Files = Readonly<Record<string, string>>

const STRING = { type: "string" }
const NASTY = 'First line.\nSecond line with */ and """ and C:\\users\\temp and a trailing quote"'
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const object = (properties: Json, required: string[] = []) => ({ properties, required, type: "object" })
const json = (schema: Json) => ({ content: { "application/json": { schema } } })
const path = (name: string): Json => ({ in: "path", name, required: true, schema: STRING })

/** An operation answering 200 with `ok`, or 204 without it. */
const op = (
	operationId: string,
	{ body, ok, ...rest }: { body?: Json; ok?: Json; summary?: string; description?: string; parameters?: Json[] } = {},
) => ({
	operationId,
	...rest,
	...(body ? { requestBody: { ...json(body), required: true } } : {}),
	responses: ok ? { 200: { ...json(ok), description: "ok" } } : { 204: { description: "done" } },
})

const SCHEMAS = {
	User: { ...object({ id: STRING, name: STRING }, ["id", "name"]), description: NASTY },
	UserCreateInput: object({ name: STRING }, ["name"]),
}

/** An HTTP-only API: a nested namespace, a single-segment id, a documented method. */
const DOCUMENT: Json = {
	components: { schemas: SCHEMAS },
	info: { description: NASTY, title: "Shop API", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/users": {
			get: op("users.list", { ok: { items: ref("User"), type: "array" } }),
			post: op("users.create", {
				body: ref("UserCreateInput"),
				description: "Creates one user.",
				ok: ref("User"),
				summary: "Create a user",
			}),
		},
		"/users/{id}": {
			delete: op("users.delete", { parameters: [path("id")] }),
			get: op("getUser", { ok: ref("User"), parameters: [path("id")] }),
		},
		"/users/{id}/profile": { get: op("users.profile.get", { ok: ref("User"), parameters: [path("id")] }) },
	},
}

/** The same API with a WebSocket operation. */
const WS_DOCUMENT: Json = {
	...DOCUMENT,
	paths: {
		...(DOCUMENT.paths as Json),
		"/live": {
			get: { operationId: "live.subscribe", responses: { 101: { description: "upgrade" } }, "x-websocket": true },
		},
	},
}

/** The runtime files gen ships verbatim, the WebSocket and realtime ones only to an API that uses them. */
const RUNTIME = readdirSync(resolve(import.meta.dirname, "../../runtime/go")).filter((name) => name.endsWith(".go"))

const sorted = (names: Iterable<string>) => [...names].sort()

/** go.mod as the toolchain reads it: the module path, the go floor and each required `module version`. */
function goMod(text: string) {
	const directive = (name: string) => text.match(new RegExp(`^${name} (\\S+)\\s*$`, "m"))?.[1]
	const single = [...text.matchAll(/^require ([^\s(]+ \S+)/gm)].map(([, line]) => line)
	const block = (text.match(/^require \(\n([\s\S]*?)\n\)/m)?.[1] ?? "").split("\n").map((line) => line.trim())
	return { go: directive("go"), module: directive("module"), require: [...single, ...block].filter(Boolean) }
}

/** The `//` comment lines directly above the first line `decl` matches, their markers stripped. */
function docAbove(text: string, decl: RegExp): string {
	const lines = text.split("\n")
	const end = lines.findIndex((line) => decl.test(line))
	let start = end
	while (start > 0 && /^\s*\/\//.test(lines[start - 1] as string)) start--
	return lines
		.slice(start, Math.max(end, start))
		.map((line) => line.replace(/^\s*\/\/ ?/, ""))
		.join("\n")
}

/** The emitted `.go` files. */
const goFiles = (files: Files) => Object.entries(files).filter(([name]) => name.endsWith(".go"))

/** The files the SDK writes itself, not copied from the runtime. */
const own = (files: Files) => sorted(Object.keys(files).filter((name) => !RUNTIME.includes(name)))

/** The `.go` files importing the WebSocket library. */
const sockets = (files: Files) =>
	goFiles(files)
		.filter(([, text]) => text.includes('"github.com/coder/websocket"'))
		.map(([name]) => name)

/** Whether each line carrying the description's second line is a comment. */
const commented = (text = "") =>
	text
		.split("\n")
		.filter((line) => line.includes("Second line with */"))
		.map((line) => /^\s*\/\/ /.test(line))

/** The document with its paths, and the methods inside each, in reverse order. */
const reordered = (document: Json): Json => ({
	...document,
	paths: Object.fromEntries(
		Object.entries(document.paths as Record<string, Json>)
			.toReversed()
			.map(([key, item]) => [key, Object.fromEntries(Object.entries(item).toReversed())]),
	),
})

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()

describe("generateGoSdk: the module", () => {
	// v0: 1c0fd18262
	it("emits client.go, types.go, doc.go, go.mod and the runtime, with WebSocket code and go.sum only for a WebSocket API", () => {
		const http = generateGoSdk(DOCUMENT).files
		const ws = generateGoSdk(WS_DOCUMENT).files
		expect({
			httpOnly: Object.keys(http).filter((name) => !(name in ws)),
			httpOwn: own(http),
			httpRuntime: RUNTIME.some((name) => name in http),
			httpSockets: sockets(http),
			wsOwn: own(ws),
			wsSockets: sockets(ws).includes("ws.go"),
		}).toEqual({
			httpOnly: [],
			httpOwn: ["client.go", "doc.go", "go.mod", "types.go"],
			httpRuntime: true,
			httpSockets: [],
			wsOwn: ["client.go", "doc.go", "go.mod", "go.sum", "types.go"],
			wsSockets: true,
		})
	})

	// v0: 1c2ad962d6
	it("names the module example.com/sdk unless given a modulePath", () => {
		expect([
			goMod(generateGoSdk(DOCUMENT).files["go.mod"] ?? "").module,
			goMod(generateGoSdk(DOCUMENT, { modulePath: "github.com/acme/acme-go" }).files["go.mod"] ?? "").module,
		]).toEqual(["example.com/sdk", "github.com/acme/acme-go"])
	})

	// v0: 7708f42d65
	it("floors go.mod at go 1.24 and requires coder/websocket with its go.sum lines, only for a WebSocket API", () => {
		const ws = generateGoSdk(WS_DOCUMENT).files
		expect({
			http: goMod(generateGoSdk(DOCUMENT).files["go.mod"] ?? ""),
			sum: (ws["go.sum"] ?? "").trim().split("\n"),
			ws: goMod(ws["go.mod"] ?? ""),
		}).toEqual({
			http: { go: "1.24", module: "example.com/sdk", require: [] },
			sum: [
				expect.stringMatching(/^github\.com\/coder\/websocket v1\.8\.15 h1:[\w+/]{43}=$/),
				expect.stringMatching(/^github\.com\/coder\/websocket v1\.8\.15\/go\.mod h1:[\w+/]{43}=$/),
			],
			ws: { go: "1.24", module: "example.com/sdk", require: ["github.com/coder/websocket v1.8.15"] },
		})
	})

	it.skipIf(!GO)(
		"builds and vets a WebSocket module under -mod=readonly, its go.sum complete",
		() => {
			/* GOFLAGS=-mod=readonly: a missing or wrong go.sum line fails the build */
			const sdk = compileGo(generateGoSdk(WS_DOCUMENT).files)
			expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
		},
		600_000,
	)
})

describe("generateGoSdk: generated files", () => {
	// v0: bcedc4394c
	it("marks every .go file generated, the way gopls and linters recognize, before its package clause", () => {
		const marks = goFiles(generateGoSdk(WS_DOCUMENT).files).map(([name, text]) => {
			const head = text.slice(0, Math.max(0, text.search(/^package /m)))
			return [name, /^\/\/ Code generated .* DO NOT EDIT\.$/m.test(head)] as const
		})
		expect({ files: marks.length > 0, unmarked: marks.filter(([, marked]) => !marked) }).toEqual({
			files: true,
			unmarked: [],
		})
	})
})

describe("generateGoSdk: godoc", () => {
	// v0: 56ead39028
	it("gives the package a godoc that starts with Package sdk and names the API", () => {
		const files = generateGoSdk(DOCUMENT).files
		expect(docAbove(files["doc.go"] ?? "", /^package sdk\b/)).toMatch(/^Package sdk [\s\S]*Shop API/)
	})

	// v0: 25c97ee210
	it("documents a method by its name, then the operation's summary and description", () => {
		const client = generateGoSdk(DOCUMENT).files["client.go"] ?? ""
		const decl = /^func\s*\(\s*\w+\s+\*UsersResource\s*\)\s*Create\s*\(/
		expect(docAbove(client, decl)).toMatch(/^Create\b[\s\S]*Create a user[\s\S]*Creates one user\./)
	})

	// v0: 0ae459e912
	it("keeps a multi-line description holding */ inside line comments in types.go and doc.go", () => {
		const files = generateGoSdk(DOCUMENT).files
		expect({ doc: commented(files["doc.go"]), types: commented(files["types.go"]) }).toEqual({
			doc: [true],
			types: [true],
		})
	})
})

describe("generateGoSdk: determinism and conflicts", () => {
	// v0: ccf0031834
	it("emits identical files for the same document twice and for its paths reordered", () => {
		const files = generateGoSdk(DOCUMENT).files
		expect([generateGoSdk(DOCUMENT).files, generateGoSdk(reordered(DOCUMENT)).files]).toEqual([files, files])
	})

	// v0: c35e3c09fe
	it("refuses an id that is both callable and a namespace, naming both ids", () => {
		const document = {
			...DOCUMENT,
			paths: {
				"/users": { post: op("users.create", { ok: ref("User") }) },
				"/users/draft": { post: op("users.create.draft", { ok: ref("User") }) },
			},
		}
		expect(() => generateGoSdk(document)).toThrow(/"users\.create"[\s\S]*"users\.create\.draft"/)
	})
})
