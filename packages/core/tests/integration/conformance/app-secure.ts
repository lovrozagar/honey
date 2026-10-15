/**
 * The conformance app's `/secure` group: users CRUD and uploads behind a bearer check. Only
 * `Bearer valid-token` passes; anything else, `Bearer expired-token` included, is `unauthorized`,
 * which is what the TS harness's onAuthExpired cases retry against.
 */
import { createHash } from "node:crypto"
import * as z from "zod"
import { defineMiddleware } from "../../../src/middleware/middleware.ts"
import type { ConformanceApp, errors } from "./app.ts"

type User = { readonly email: string; readonly id: string; readonly name: string }

const UserSchema = z.object({ email: z.string(), id: z.string(), name: z.string() })
const Fields = z.object({ email: z.string().optional(), name: z.string().optional() })

/** One `required` field error at `path`. */
const required = (path: string) => [{ error_key: "required", message: `${path} is required`, path }]

/** The field errors of a create body missing its name or email; null when both are there. */
function missingFields(body: { email?: string; name?: string }) {
	const missing = (["name", "email"] as const).filter((key) => !body[key])
	if (missing.length === 0) return null
	return Object.fromEntries(missing.map((key) => [key, required(key)]))
}

/** The `/secure` handle: every route behind the bearer check. */
function secured(root: ConformanceApp, factory: typeof errors) {
	const auth = defineMiddleware({
		errors: [factory, "unauthorized"],
		fn: (ctx: { readonly req: Request }, proceed) => {
			if (ctx.req.headers.get("authorization") !== "Bearer valid-token") throw factory.unauthorized()
			return proceed()
		},
	})
	return root.basePath("/secure").use(auth)
}

type Secure = ReturnType<typeof secured>

/** `users.*`, the users in this app's closure, `taken@example.com` seeded. */
function userRoutes(app: Secure, factory: typeof errors): void {
	const users = new Map<string, User>([["user-0", { email: "taken@example.com", id: "user-0", name: "Taken" }]])
	let next = 0
	app
		.get("/users")
		.meta({ operationId: "users.list" })
		.output({ "application/json": { ok: z.array(UserSchema) } })
		.handler((ctx) => ctx.res.json("ok", [...users.values()]))
	app
		.post("/users")
		.meta({ operationId: "users.create" })
		.errors("invalid_input", "email_taken")
		.input({ json: Fields })
		.output({ "application/json": { created: UserSchema } })
		.handler((ctx) => {
			const fields = missingFields(ctx.input.json)
			if (fields !== null) throw factory.invalid_input({ fields })
			const { email, name } = ctx.input.json as { email: string; name: string }
			if ([...users.values()].some((user) => user.email === email)) throw factory.email_taken()
			const user = { email, id: `user-${++next}`, name }
			users.set(user.id, user)
			return ctx.res.json("created", user)
		})
	app
		.get("/users/:id")
		.meta({ operationId: "users.get" })
		.errors("not_found")
		.output({ "application/json": { ok: UserSchema } })
		.handler((ctx) => {
			const user = users.get(ctx.params.id)
			if (user === undefined) throw factory.not_found()
			return ctx.res.json("ok", user)
		})
	app
		.put("/users/:id")
		.meta({ operationId: "users.update" })
		.input({ json: Fields })
		.output({ "application/json": { ok: UserSchema } })
		.handler((ctx) => {
			const user = { email: "", name: "", ...users.get(ctx.params.id), ...ctx.input.json, id: ctx.params.id }
			users.set(user.id, user)
			return ctx.res.json("ok", user)
		})
	app
		.delete("/users/:id")
		.meta({ operationId: "users.delete" })
		.output({ headers: { no_content: z.object({}) } })
		.handler((ctx) => {
			users.delete(ctx.params.id)
			return ctx.res.noContent()
		})
}

/** `uploads.*`: a raw body and a multipart file, each answered with what arrived. */
function uploadRoutes(app: Secure): void {
	app
		.post("/uploads/blob")
		.meta({ operationId: "uploads.blob" })
		.input({ binary: ["application/octet-stream"] })
		.output({ "application/json": { ok: z.object({ sha256: z.string(), size: z.number().int() }) } })
		.handler((ctx) => {
			const { bytes } = ctx.input.binary
			return ctx.res.json("ok", { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength })
		})
	app
		.post("/uploads/form")
		.meta({ operationId: "uploads.form" })
		.input({ form: z.object({ file: z.file() }) })
		.output({ "application/json": { ok: z.object({ size: z.number().int() }) } })
		.handler((ctx) => ctx.res.json("ok", { size: ctx.input.form.file.size }))
}

/** `users.*` and `uploads.*` under `/secure`. */
export function secureRoutes(root: ConformanceApp, factory: typeof errors): void {
	const app = secured(root, factory)
	userRoutes(app, factory)
	uploadRoutes(app)
}
