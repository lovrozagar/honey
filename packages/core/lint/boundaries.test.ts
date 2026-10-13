import { describe, expect, it } from "vitest"
import plugin from "./boundaries.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules.boundaries
const NODE = "node builtins are for the Node adapter and build-time code only"
const ADAPTER = "only the same runtime's adapter may import an adapter"
const ESCAPE = "an import stays inside its package's src (no _v0, no sibling package)"
const WS = "ws is for the Node WebSocket adapter only"
const TS_MORPH = "ts-morph is for honey-codegen's extract/ only"
const CODEGEN = "core reaches honey-codegen from build/ only"
const INTERNAL = "honey-codegen reads @lovrozagar/honey through public subpaths only"
const global = (name: string) => `${name} is not available here (00-rules environments)`

describe("honey/boundaries: imports", () => {
	it("keeps node builtins in the Node adapter and build-time code", () => {
		const fixture = {
			"packages/core/src/routing/app.ts": 'import { readFileSync } from "node:fs"\nimport path from "path"\n',
			"packages/core/src/adapters/node/serve.ts": 'import { createServer } from "node:http"\n',
			"packages/core/src/ws/node.ts": 'import { STATUS_CODES } from "node:http"\n',
			"packages/core/src/build/plugin.ts": 'import { readFileSync } from "node:fs"\n',
			"packages/gen/src/gen/write.ts": 'import { writeFileSync } from "node:fs"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/routing/app.ts", message: NODE },
			{ file: "packages/core/src/routing/app.ts", message: NODE },
		])
	})

	it("lets only the same runtime import an adapter, statically or dynamically", () => {
		const fixture = {
			"packages/core/src/routing/dispatch.ts": 'import { serve } from "../adapters/node/serve.ts"\n',
			"packages/core/src/runtime/peer.ts": 'export const load = () => import("../ws/bun.ts")\n',
			"packages/core/src/response/sse.ts": 'export { cfWebSocket } from "../ws/cloudflare.ts"\n',
			"packages/core/src/adapters/bun/serve.ts": 'import { bunWebSocket } from "../../ws/bun.ts"\n',
			"packages/core/src/adapters/node/serve.ts":
				'import { nodeWebSocket } from "../../ws/node.ts"\nimport { x } from "../workers/serve.ts"\n',
			"packages/core/src/adapters/workers/serve.ts": 'import { route } from "../../routing/app.ts"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/routing/dispatch.ts", message: ADAPTER },
			{ file: "packages/core/src/runtime/peer.ts", message: ADAPTER },
			{ file: "packages/core/src/response/sse.ts", message: ADAPTER },
			{ file: "packages/core/src/adapters/node/serve.ts", message: ADAPTER },
		])
	})

	it("never leaves the package's src: no _v0, no sibling package by path", () => {
		const fixture = {
			"packages/core/src/routing/app.ts": 'import { Honey } from "../../_v0/src/index.ts"\n',
			"packages/core/src/errors/error.ts": 'export * from "../../../gen/src/ir/model.ts"\n',
			"packages/gen/src/ir/build.ts": 'import { x } from "../../../core/src/routing/app.ts"\n',
			"packages/core/src/routing/match.ts":
				'import { tree } from "./tree.ts"\nimport { e } from "../errors/error.ts"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/routing/app.ts", message: ESCAPE },
			{ file: "packages/core/src/errors/error.ts", message: ESCAPE },
			{ file: "packages/gen/src/ir/build.ts", message: ESCAPE },
		])
	})
})

describe("honey/boundaries: packages", () => {
	it("pins ws, ts-morph and honey-codegen to their one importer", () => {
		const fixture = {
			"packages/core/src/ws/session.ts": 'import { WebSocketServer } from "ws"\n',
			"packages/core/src/ws/node.ts": 'import { WebSocketServer } from "ws"\n',
			"packages/gen/src/emit/ts/sdk.ts": 'import { Project } from "ts-morph"\n',
			"packages/gen/src/extract/extract.ts": 'import { Project } from "ts-morph"\n',
			"packages/core/src/openapi/document.ts": 'import { generate } from "@lovrozagar/honey-codegen"\n',
			"packages/core/src/build/plugin.ts": 'import { generateTypes } from "@lovrozagar/honey-codegen"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/ws/session.ts", message: WS },
			{ file: "packages/gen/src/emit/ts/sdk.ts", message: TS_MORPH },
			{ file: "packages/core/src/openapi/document.ts", message: CODEGEN },
		])
	})

	it("keeps honey-codegen on @lovrozagar/honey's public subpaths", () => {
		const fixture = {
			"packages/gen/src/ir/load.ts": [
				'import type { OpenApiSpec } from "@lovrozagar/honey/openapi"',
				'import { x } from "@lovrozagar/honey/src/routing/app.ts"',
				'import { y } from "@lovrozagar/honey/_v0/src/codegen.ts"',
				'import { z } from "@lovrozagar/honey/dist/index.js"',
				"",
			].join("\n"),
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/gen/src/ir/load.ts", message: INTERNAL },
			{ file: "packages/gen/src/ir/load.ts", message: INTERNAL },
			{ file: "packages/gen/src/ir/load.ts", message: INTERNAL },
		])
	})
})

describe("honey/boundaries: runtime globals", () => {
	it("keeps each runtime's globals in its own adapter", () => {
		const fixture = {
			"packages/core/src/routing/app.ts": [
				"export const a = process.env.X",
				"export const b = Buffer.from('x')",
				"export const c = typeof Bun",
				"export const e = new WebSocketPair()",
				"export const f = window.location",
				"export const g = document.title",
				"",
			].join("\n"),
			"packages/core/src/adapters/node/serve.ts":
				"export const a = process.env.PORT\nexport const b = Buffer.alloc(1)\n",
			"packages/core/src/adapters/bun/serve.ts": "export const s = Bun.serve\n",
			"packages/core/src/ws/cloudflare.ts": "export const p = new WebSocketPair()\n",
			"packages/core/src/build/cli.ts": "export const argv = process.argv\n",
			"packages/gen/src/cli.ts": "export const argv = process.argv\n",
			"packages/core/src/routing/match.ts": "const o = { process: 1, Bun: 2 }\nexport const n = o.process + o.Bun\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/routing/app.ts", message: global("process") },
			{ file: "packages/core/src/routing/app.ts", message: global("Buffer") },
			{ file: "packages/core/src/routing/app.ts", message: global("Bun") },
			{ file: "packages/core/src/routing/app.ts", message: global("WebSocketPair") },
			{ file: "packages/core/src/routing/app.ts", message: global("window") },
			{ file: "packages/core/src/routing/app.ts", message: global("document") },
		])
	})

	it("ignores tests and files outside the packages' src", () => {
		const fixture = {
			"packages/core/src/routing/app.test.ts": 'import { readFileSync } from "node:fs"\nexport const a = process.env\n',
			"packages/core/tests/integration/routing.test.ts": 'import { x } from "../../_v0/src/index.ts"\n',
			"bench/src/hotpath.ts": 'import { readFileSync } from "node:fs"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the honey plugin entry", () => {
		const fixture = {
			"packages/core/src/routing/app.ts": 'import { readFileSync } from "node:fs"\n',
			"packages/core/src/adapters/node/serve.ts": 'import { createServer } from "node:http"\n',
		}
		expect(oxlintReports("boundaries", fixture)).toEqual([{ file: "packages/core/src/routing/app.ts", message: NODE }])
	})
})
