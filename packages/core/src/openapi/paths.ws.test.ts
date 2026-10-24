import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../routing/app.ts"
import { SILENT, type Logger } from "../telemetry/logger.ts"
import { generateOpenApi } from "./generate.ts"

const INFO = { title: "T", version: "1" }
type Doc = ReturnType<typeof generateOpenApi>
type Param = { in: string; name: string }

const op = (doc: Doc, path: string, method = "get") => (doc.paths[path]?.[method] ?? {}) as Record<string, unknown>
const params = (doc: Doc, path: string, method = "get") => (op(doc, path, method).parameters ?? []) as Param[]
const names = (doc: Doc, path: string, method = "get") => params(doc, path, method).map((p) => p.name)

/** A logger that keeps each warning's message. */
function recording(): { logger: Logger; warnings: string[] } {
	const warnings: string[] = []
	const warn = (first: unknown, second?: unknown) =>
		void warnings.push(String(typeof first === "string" ? first : second))
	return { logger: { ...SILENT, warn }, warnings }
}

describe("WebSocket operations", () => {
	// v0: 4c2b9d2aa5
	// v0: 74e37ef9b9
	// v0: 7629efa019
	// v0: 780b2e4126
	// v0: d537e2ff0d
	// v0: 8b32760001
	it("document a WS route as a GET upgrade: its policy run as ws, its search fields as parameters bar x-internal ones", () => {
		const app = honey<{}>().meta<{ tenant?: string }>()
		app.metaSpec({ meta: { tenant: { key: "x-tenant", on: "http" } } })
		app
			.get("/a")
			.meta({ tenant: "orgId" })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.ws("/live")
			.meta({ tenant: "orgId" } as never)
			.input({ search: z.object({ secret: z.string().meta({ "x-internal": true }), token: z.string() }) })
			.handler({ onMessage() {} })
		app.ws("/ws/chat/:channelId").handler({ onMessage() {} })
		const doc = generateOpenApi(app, { info: INFO })
		expect(params(doc, "/ws/chat/{channelId}").map((p) => [p.name, p.in])).toEqual([["channelId", "path"]])
		expect([
			op(doc, "/a")["x-tenant"],
			op(doc, "/live")["x-tenant"],
			op(doc, "/live")["x-websocket"],
			names(doc, "/live"),
			op(doc, "/live").responses,
		]).toEqual(["orgId", undefined, true, ["token"], { "101": { description: "WebSocket upgrade" } }])
	})

	it("leaves out a WS route an HTTP GET of the same path shadows, and says so through the logger", () => {
		const app = honey<{}>()
		app.get("/chat").handler((c) => c.res.text("ok", "ok"))
		app.ws("/chat").handler({ onMessage() {} })
		const { logger, warnings } = recording()
		const doc = generateOpenApi(app, { info: INFO, logger })
		expect([op(doc, "/chat")["x-websocket"], warnings]).toEqual([
			undefined,
			[expect.stringMatching(/WS_SHADOWED.*WS \/chat/s)],
		])
	})

	// v0: e61795b84c
	it("leaves out a WS route marked internal and one filterRoutes rejects, keeping the rest", () => {
		const app = honey<{}>()
		app.ws("/open").handler({ onMessage() {} })
		app
			.ws("/hidden")
			.meta({ internal: true })
			.handler({ onMessage() {} })
		app.ws("/filtered").handler({ onMessage() {} })
		const doc = generateOpenApi(app, { filterRoutes: (route) => route.path !== "/filtered", info: INFO })
		expect([Object.keys(doc.paths), op(doc, "/open")["x-websocket"]]).toEqual([["/open"], true])
	})
})

describe("a WS route's own keys", () => {
	// v0: 10d1ae37cb
	it("documents a WS route with its own keys alone: never deprecated, security, x-invalidate or x-mcp", () => {
		const app = honey<{}>()
		const every = {
			deprecated: true,
			description: "d",
			invalidate: ["GET /users"],
			mcp: true,
			operationId: "live",
			security: "jwt",
			summary: "s",
			tags: "sockets",
		}
		app
			.ws("/live")
			.meta(every as never)
			.handler({ onMessage() {} })
		expect(Object.keys(op(generateOpenApi(app, { info: INFO }), "/live"))).toEqual([
			"x-websocket",
			"summary",
			"description",
			"tags",
			"operationId",
			"x-honey-route",
			"responses",
		])
	})
})
