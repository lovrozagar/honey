/**
 * The MCP e2e app's routes (bit 21 e): Anyrow's five public multipart operations, each `mcp: true` and requiring the
 * `apiKey` scheme, behind a per-route guard taking `Authorization: ApiKey <KEY>` alone (else 401 with its challenge),
 * as Anyrow's gateway guards them. Under `/api`, which the app strips. Each answer names every part it read: a file's
 * name, size and SHA-256, a text part as sent. The streams send a batch, one progress per file, then the completion.
 * No mount here: gen-app.ts documents these routes, so generation never imports the handler it writes.
 */
import { createMiddleware, honey } from "@lovrozagar/honey"
import type { RouteTree } from "@lovrozagar/honey/tree"
import * as z from "zod"
import { KEY } from "./key.ts"

const text = z.string().max(1_000_000).optional()
const extractForm = z.object({
	columns: z.string().optional(),
	file: z.file().optional(),
	instruction: text,
	schema: z.string().optional(),
	strictness: z.enum(["strict", "balanced", "flexible"]).optional(),
	text,
})
const tableForm = z.object({ file: z.file().optional(), text })

const read = z.object({
	files: z.array(z.object({ file_name: z.string(), sha256: z.string(), size: z.number() })),
	status: z.string(),
	texts: z.record(z.string(), z.string()),
})

/** `form`'s parts as an answer reads them: each file by name, size and SHA-256, each text as sent. */
async function readOf(form: Record<string, unknown>) {
	const files: { file_name: string; sha256: string; size: number }[] = []
	const texts: Record<string, string> = {}
	for (const [name, value] of Object.entries(form)) {
		if (typeof value === "string") texts[name] = value
		if (!(value instanceof File)) continue
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await value.arrayBuffer()))
		const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
		files.push({ file_name: value.name, sha256, size: value.size })
	}
	return { files, status: "complete", texts }
}

/** Anyrow's guard: the one key, else 401 naming the ApiKey scheme. */
const apiKeyAccess = createMiddleware(async (ctx: { req: Request }, next) =>
	ctx.req.headers.get("authorization") === `ApiKey ${KEY}`
		? next()
		: new Response(null, { headers: { "www-authenticate": 'ApiKey realm="honey-e2e"' }, status: 401 }),
)

const SECURED = { mcp: true as const, security: [{ apiKey: ["extract:write"] }] }

export type AppOptions = { routeTree?: RouteTree }

/** The app with its five operations, and the handle under no guard an MCP mount goes on. */
export function createRoutes(options?: AppOptions) {
	const app = honey().stripPrefix("/api")
	if (options?.routeTree) app.routeTree(options.routeTree)
	app
		.use(apiKeyAccess)
		.post("/v1/projects/:project_id/extract")
		.meta({ ...SECURED, operationId: "extract.once" })
		.input({ form: extractForm })
		.output({ "application/json": { ok: read } })
		.handler(async (ctx) => ctx.res.json("ok", await readOf(ctx.input.form)))
		.post("/v1/projects/:project_id/extract-stream")
		.meta({ ...SECURED, operationId: "extract.stream" })
		.input({ form: extractForm })
		.output({ "text/event-stream": { ok: z.string() } })
		.handler(async (ctx) => {
			const answer = await readOf(ctx.input.form)
			return ctx.res.sse((stream) => streamed(stream, answer))
		})
		.post("/v1/projects/:project_id/suggest-schema")
		.meta({ ...SECURED, operationId: "suggest.schema" })
		.input({ form: tableForm })
		.output({ "application/json": { ok: read } })
		.handler(async (ctx) => ctx.res.json("ok", await readOf(ctx.input.form)))
		.post("/v1/projects/:project_id/tables/:table_id/extract")
		.meta({ ...SECURED, operationId: "extract.table.once" })
		.input({ form: tableForm })
		.output({ "application/json": { ok: read } })
		.handler(async (ctx) => ctx.res.json("ok", await readOf(ctx.input.form)))
		.post("/v1/projects/:project_id/tables/:table_id/extract-stream")
		.meta({ ...SECURED, operationId: "extract.table.stream" })
		.input({ form: tableForm })
		.output({ "text/event-stream": { ok: z.string() } })
		.handler(async (ctx) => {
			const answer = await readOf(ctx.input.form)
			return ctx.res.sse((stream) => streamed(stream, answer))
		})
	return app
}

/** An event stream as the route writes it. */
type Events = { send(event: { data: string; event: string }): Promise<void>; close(): void }

/** Anyrow's stream: the batch, a progress event per file read, the completion. */
async function streamed(stream: Events, answer: Awaited<ReturnType<typeof readOf>>) {
	await stream.send({ data: JSON.stringify({ batch_id: "b1", total: answer.files.length }), event: "batch" })
	for (const file of answer.files) await stream.send({ data: JSON.stringify(file), event: "progress" })
	await stream.send({ data: JSON.stringify({ batch_id: "b1", status: "complete" }), event: "complete" })
	stream.close()
}
