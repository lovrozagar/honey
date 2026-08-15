import * as z from "zod"
import type { InputFor, IsSSE, OutputFor, PathsForMethod } from "../../src/client/types.ts"
import { honey } from "../../src/index.ts"
import type { InferMethods, InferRouteInput, InferRouteMethods, InferRoutes } from "../../src/index.ts"
import type { Eq, Expect } from "./_assert.ts"

/* ── every verb lands as a lowercase method key ── */

const verbs = honey()
	.get("/g")
	.handler((c) => c.res.text("ok", "g"))
	.post("/p")
	.handler((c) => c.res.json("created", {}))
	.put("/u")
	.handler((c) => c.res.json("ok", {}))
	.patch("/a")
	.handler((c) => c.res.json("ok", {}))
	.delete("/d")
	.handler((c) => c.res.text("ok", "d"))
	.head("/h")
	.handler((c) => c.res.text("ok", ""))
	.options("/o")
	.handler((c) => c.res.text("ok", ""))
	.all("/any")
	.handler((c) => c.res.text("ok", "any"))

type _Verbs = Expect<
	Eq<InferMethods<typeof verbs>, "all" | "delete" | "get" | "head" | "options" | "patch" | "post" | "put">
>
type _All = Expect<Eq<InferRouteMethods<typeof verbs, "/any">, "all">>
type _Get = Expect<Eq<InferRouteMethods<typeof verbs, "/g">, "get">>

/* ── .on() registers every listed method on one path ── */

const multi = honey()
	.on(["GET", "POST"], "/shared")
	.input({ search: z.object({ q: z.string() }) })
	.handler((c) => c.res.json("ok", { q: c.input.search.q }))

type _OnVerbs = Expect<Eq<InferRouteMethods<typeof multi, "/shared">, "get" | "post">>
type _OnGet = Expect<Eq<InferRouteInput<typeof multi, "/shared", "get">, { search: { q: string } }>>
type _OnPost = Expect<Eq<InferRouteInput<typeof multi, "/shared", "post">, { search: { q: string } }>>

/* ── client extracts from InferRoutes ── */

const app = honey()
	.get("/health")
	.handler((c) => c.res.text("ok", "ok"))
	.get("/users")
	.output({ "application/json": { ok: z.object({ id: z.string(), name: z.string() }).array() } })
	.handler((c) => c.res.json("ok", [{ id: "1", name: "n" }]))
	.post("/users")
	.input({ json: z.object({ name: z.string() }) })
	.output({ "application/json": { created: z.object({ id: z.string() }) } })
	.handler((c) => c.res.json("created", { id: "1" }))
	.get("/events")
	.output({ "text/event-stream": { ok: z.object({ data: z.string() }) } })
	.handler((c) => c.res.sse(async () => {}))

type Routes = InferRoutes<typeof app>

type _GetPaths = Expect<Eq<PathsForMethod<Routes, "get">, "/events" | "/health" | "/users">>
type _PostPaths = Expect<Eq<PathsForMethod<Routes, "post">, "/users">>
type _ClientIn = Expect<Eq<InputFor<Routes, "/users", "post">, { json: { name: string } }>>
type _ClientEmpty = Expect<Eq<InputFor<Routes, "/health", "get">, {}>>
type _ClientOut = Expect<Eq<OutputFor<Routes, "/users", "get">, { id: string; name: string }[]>>
type _ClientCreated = Expect<Eq<OutputFor<Routes, "/users", "post">, { id: string }>>
type _Sse = Expect<Eq<IsSSE<Routes, "/events", "get">, true>>
type _NotSse = Expect<Eq<IsSSE<Routes, "/health", "get">, false>>
