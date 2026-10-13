import * as z from "zod"
import { honey } from "../../src/index.ts"
import type { InferRouteCtx, InferRouteInput } from "../../src/index.ts"
import type { ParamKeys, ParamsFromPath } from "../../src/types.ts"
import type { Eq, Expect, Extends, IsNever } from "./_assert.ts"

type _P1 = Expect<Eq<ParamKeys<"/users/:id">, "id">>
type _P2 = Expect<Eq<ParamKeys<"/users/:id/posts/:postId">, "id" | "postId">>
type _P3 = Expect<Eq<ParamKeys<"/files/*path">, "path">>
type _P4 = Expect<Eq<ParamKeys<"/files/*">, "*">>
type _P5 = Expect<Eq<ParamKeys<"/users/:id?">, "id">>
type _P6 = Expect<IsNever<ParamKeys<"/health">>>
type _P7 = Expect<IsNever<ParamKeys<"/">>>
type _P8 = Expect<Eq<ParamKeys<"/a/:b/c/:d/e/:f">, "b" | "d" | "f">>

type _M1 = Expect<Eq<ParamsFromPath<"/users/:id">, { id: string }>>
type _M2 = Expect<Eq<ParamsFromPath<"/users/:id/posts/:postId">, { id: string; postId: string }>>
type _M3 = Expect<Eq<ParamsFromPath<"/health">, Record<string, string>>>
type _M4 = Expect<Eq<ParamsFromPath<"/files/*path">, { path: string }>>

const app = honey()
	.get("/users/:userId")
	.handler((ctx) => {
		type _Id = Expect<Eq<typeof ctx.params.userId, string>>
		return ctx.res.text("ok", ctx.params.userId)
	})
	.get("/users/:userId/posts/:postId")
	.handler((ctx) => {
		type _U = Expect<Eq<typeof ctx.params.userId, string>>
		type _P = Expect<Eq<typeof ctx.params.postId, string>>
		return ctx.res.text("ok", "ok")
	})
	.get("/files/*path")
	.handler((ctx) => {
		type _W = Expect<Eq<typeof ctx.params.path, string>>
		return ctx.res.text("ok", ctx.params.path)
	})
	.post("/users/:userId/notes")
	.input({
		json: z.object({ body: z.string() }),
		search: z.object({ draft: z.string() }),
	})
	.handler((ctx) => {
		type _In = Expect<Eq<typeof ctx.input, { json: { body: string }; search: { draft: string } }>>
		type _Param = Expect<Eq<typeof ctx.params.userId, string>>
		return ctx.res.json("created", { body: ctx.input.json.body })
	})

type _Ctx = Expect<Extends<InferRouteCtx<typeof app, "/users/:userId", "get">, { readonly params: { userId: string } }>>
type _NoteIn = Expect<
	Eq<InferRouteInput<typeof app, "/users/:userId/notes", "post">, { json: { body: string }; search: { draft: string } }>
>

const sources = honey()
	.post("/ingest")
	.input({
		cookies: z.object({ sid: z.string() }),
		headers: z.object({ "x-req": z.string() }),
		json: z.object({ n: z.number() }),
		params: z.object({ extra: z.string() }),
		search: z.object({ q: z.string() }),
	})
	.handler((ctx) => {
		type _All = Expect<
			Eq<
				typeof ctx.input,
				{
					cookies: { sid: string }
					headers: { "x-req": string }
					json: { n: number }
					params: { extra: string }
					search: { q: string }
				}
			>
		>
		return ctx.res.json("ok", { n: ctx.input.json.n })
	})

type _Sources = Expect<
	Eq<
		InferRouteInput<typeof sources, "/ingest", "post">,
		{
			cookies: { sid: string }
			headers: { "x-req": string }
			json: { n: number }
			params: { extra: string }
			search: { q: string }
		}
	>
>

const form = honey()
	.post("/upload")
	.input({ form: z.object({ name: z.string() }) })
	.handler((ctx) => {
		type _F = Expect<Eq<typeof ctx.input.form, { name: string }>>
		return ctx.res.json("created", { name: ctx.input.form.name })
	})

type _Form = Expect<Eq<InferRouteInput<typeof form, "/upload", "post">, { form: { name: string } }>>

honey()
	.post("/either")
	.input({ json: z.object({ n: z.number() }) })
	.handler((ctx) => ctx.res.json("ok", { n: ctx.input.json.n }))

honey()
	.post("/bad")
	// @ts-expect-error — json and form are mutually exclusive
	.input({ form: z.object({ n: z.string() }), json: z.object({ n: z.number() }) })
