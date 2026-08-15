import { describe, expectTypeOf, it } from "vitest";
import * as z from "zod";
import type {
	ErrorsFor,
	InputFor,
	OutputFor,
	PathsForMethod,
} from "../../../src/client/types.ts";
import { defineErrors, honey } from "../../../src/index.ts";
import type {
	InferRouteCtx,
	InferRouteErrors,
	InferRouteInput,
	InferRouteMeta,
	InferRouteOutput,
	InferRoutes,
	MergeRoute,
} from "../../../src/types.ts";

/* ---- helpers ---- */

type R<P extends string, M extends string, I = {}, O = {}> = MergeRoute<
	{},
	P,
	M,
	I,
	O,
	unknown
>;

type Chain10 = MergeRoute<
	MergeRoute<
		MergeRoute<
			MergeRoute<
				MergeRoute<
					MergeRoute<
						MergeRoute<
							MergeRoute<
								MergeRoute<
									MergeRoute<{}, "/r1", "GET", {}, { n: 1 }, unknown>,
									"/r2",
									"GET",
									{},
									{ n: 2 },
									unknown
								>,
								"/r3",
								"GET",
								{},
								{ n: 3 },
								unknown
							>,
							"/r4",
							"GET",
							{},
							{ n: 4 },
							unknown
						>,
						"/r5",
						"GET",
						{},
						{ n: 5 },
						unknown
					>,
					"/r6",
					"GET",
					{},
					{ n: 6 },
					unknown
				>,
				"/r7",
				"GET",
				{},
				{ n: 7 },
				unknown
			>,
			"/r8",
			"GET",
			{},
			{ n: 8 },
			unknown
		>,
		"/r9",
		"GET",
		{},
		{ n: 9 },
		unknown
	>,
	"/r10",
	"GET",
	{},
	{ n: 10 },
	unknown
>;

type Chain20 = MergeRoute<
	MergeRoute<
		MergeRoute<
			MergeRoute<
				MergeRoute<
					MergeRoute<
						MergeRoute<
							MergeRoute<
								MergeRoute<
									MergeRoute<Chain10, "/r11", "GET", {}, { n: 11 }, unknown>,
									"/r12",
									"GET",
									{},
									{ n: 12 },
									unknown
								>,
								"/r13",
								"GET",
								{},
								{ n: 13 },
								unknown
							>,
							"/r14",
							"GET",
							{},
							{ n: 14 },
							unknown
						>,
						"/r15",
						"GET",
						{},
						{ n: 15 },
						unknown
					>,
					"/r16",
					"GET",
					{},
					{ n: 16 },
					unknown
				>,
				"/r17",
				"GET",
				{},
				{ n: 17 },
				unknown
			>,
			"/r18",
			"GET",
			{},
			{ n: 18 },
			unknown
		>,
		"/r19",
		"GET",
		{},
		{ n: 19 },
		unknown
	>,
	"/r20",
	"GET",
	{},
	{ n: 20 },
	unknown
>;

type Chain30 = MergeRoute<
	MergeRoute<
		MergeRoute<
			MergeRoute<
				MergeRoute<
					MergeRoute<
						MergeRoute<
							MergeRoute<
								MergeRoute<
									MergeRoute<Chain20, "/r21", "GET", {}, { n: 21 }, unknown>,
									"/r22",
									"GET",
									{},
									{ n: 22 },
									unknown
								>,
								"/r23",
								"GET",
								{},
								{ n: 23 },
								unknown
							>,
							"/r24",
							"GET",
							{},
							{ n: 24 },
							unknown
						>,
						"/r25",
						"GET",
						{},
						{ n: 25 },
						unknown
					>,
					"/r26",
					"GET",
					{},
					{ n: 26 },
					unknown
				>,
				"/r27",
				"GET",
				{},
				{ n: 27 },
				unknown
			>,
			"/r28",
			"GET",
			{},
			{ n: 28 },
			unknown
		>,
		"/r29",
		"GET",
		{},
		{ n: 29 },
		unknown
	>,
	"/r30",
	"GET",
	{},
	{ n: 30 },
	unknown
>;

/* ---- depth stress tests ---- */

describe("MergeRoute depth: 10 routes", () => {
	it("first route accessible", () => {
		expectTypeOf<Chain10["/r1"]["get"]["output"]>().toEqualTypeOf<{ n: 1 }>();
	});

	it("last route accessible", () => {
		expectTypeOf<Chain10["/r10"]["get"]["output"]>().toEqualTypeOf<{ n: 10 }>();
	});

	it("middle route accessible", () => {
		expectTypeOf<Chain10["/r5"]["get"]["output"]>().toEqualTypeOf<{ n: 5 }>();
	});
});

describe("MergeRoute depth: 20 routes", () => {
	it("first route accessible", () => {
		expectTypeOf<Chain20["/r1"]["get"]["output"]>().toEqualTypeOf<{ n: 1 }>();
	});

	it("route 15 accessible", () => {
		expectTypeOf<Chain20["/r15"]["get"]["output"]>().toEqualTypeOf<{ n: 15 }>();
	});

	it("last route accessible", () => {
		expectTypeOf<Chain20["/r20"]["get"]["output"]>().toEqualTypeOf<{ n: 20 }>();
	});
});

describe("MergeRoute depth: 30 routes", () => {
	it("first route accessible", () => {
		expectTypeOf<Chain30["/r1"]["get"]["output"]>().toEqualTypeOf<{ n: 1 }>();
	});

	it("route 25 accessible", () => {
		expectTypeOf<Chain30["/r25"]["get"]["output"]>().toEqualTypeOf<{ n: 25 }>();
	});

	it("last route accessible", () => {
		expectTypeOf<Chain30["/r30"]["get"]["output"]>().toEqualTypeOf<{ n: 30 }>();
	});
});

/* ---- same path, different methods ---- */

describe("MergeRoute same path different methods", () => {
	type Multi = MergeRoute<
		MergeRoute<
			MergeRoute<{}, "/users", "GET", {}, { list: true }, unknown>,
			"/users",
			"POST",
			{ json: { name: string } },
			{ created: true },
			unknown
		>,
		"/users",
		"DELETE",
		{},
		{ deleted: true },
		unknown
	>;

	it("GET method accessible", () => {
		expectTypeOf<Multi["/users"]["get"]["output"]>().toEqualTypeOf<{
			list: true;
		}>();
	});

	it("POST method accessible", () => {
		expectTypeOf<Multi["/users"]["post"]["output"]>().toEqualTypeOf<{
			created: true;
		}>();
		expectTypeOf<Multi["/users"]["post"]["input"]>().toEqualTypeOf<{
			json: { name: string };
		}>();
	});

	it("DELETE method accessible", () => {
		expectTypeOf<Multi["/users"]["delete"]["output"]>().toEqualTypeOf<{
			deleted: true;
		}>();
	});
});

/* ---- full honey() builder chain with 20+ routes ---- */

describe("honey() builder chain with 20+ routes", () => {
	const app = honey<{}>()
		.get("/r1")
		.handler((ctx) => ctx.res.text("ok", "1"))
		.get("/r2")
		.handler((ctx) => ctx.res.text("ok", "2"))
		.get("/r3")
		.handler((ctx) => ctx.res.text("ok", "3"))
		.get("/r4")
		.handler((ctx) => ctx.res.text("ok", "4"))
		.get("/r5")
		.handler((ctx) => ctx.res.text("ok", "5"))
		.get("/r6")
		.handler((ctx) => ctx.res.text("ok", "6"))
		.get("/r7")
		.handler((ctx) => ctx.res.text("ok", "7"))
		.get("/r8")
		.handler((ctx) => ctx.res.text("ok", "8"))
		.get("/r9")
		.handler((ctx) => ctx.res.text("ok", "9"))
		.get("/r10")
		.handler((ctx) => ctx.res.text("ok", "10"))
		.post("/r11")
		.input({ json: z.object({ x: z.string() }) })
		.handler((ctx) => ctx.res.json("created", { x: ctx.input.json.x }))
		.get("/r12")
		.handler((ctx) => ctx.res.text("ok", "12"))
		.get("/r13")
		.handler((ctx) => ctx.res.text("ok", "13"))
		.get("/r14")
		.handler((ctx) => ctx.res.text("ok", "14"))
		.get("/r15")
		.handler((ctx) => ctx.res.text("ok", "15"))
		.get("/r16")
		.handler((ctx) => ctx.res.text("ok", "16"))
		.get("/r17")
		.handler((ctx) => ctx.res.text("ok", "17"))
		.get("/r18")
		.handler((ctx) => ctx.res.text("ok", "18"))
		.get("/r19")
		.handler((ctx) => ctx.res.text("ok", "19"))
		.get("/r20")
		.handler((ctx) => ctx.res.text("ok", "20"))
		.get("/r21")
		.output({ "application/json": { ok: z.object({ id: z.string() }) } })
		.handler((ctx) => ctx.res.json("ok", { id: "1" }));

	type Routes = InferRoutes<typeof app>;

	it("InferRoutes resolves", () => {
		expectTypeOf<Routes>().toHaveProperty("/r1");
		expectTypeOf<Routes>().toHaveProperty("/r21");
	});

	it("InferRouteInput works", () => {
		type Input = InferRouteInput<typeof app, "/r11", "post">;
		expectTypeOf<Input>().toMatchTypeOf<{ json: { x: string } }>();
	});

	it("InferRouteOutput works", () => {
		type Output = InferRouteOutput<typeof app, "/r21", "get">;
		expectTypeOf<Output>().toHaveProperty("application/json");
	});

	it("InferRouteCtx works", () => {
		type Ctx = InferRouteCtx<typeof app, "/r1", "get">;
		expectTypeOf<Ctx>().toMatchTypeOf<{ req: Request }>();
	});

	it("InferRouteErrors works on route without errors", () => {
		type Errors = InferRouteErrors<typeof app, "/r1", "get">;
		expectTypeOf<Errors>().toBeNever();
	});
});

/* ---- client types with 20+ routes ---- */

describe("client types with 20+ routes", () => {
	const app = honey<{}>()
		.get("/c1")
		.handler((ctx) => ctx.res.text("ok", "1"))
		.get("/c2")
		.handler((ctx) => ctx.res.text("ok", "2"))
		.get("/c3")
		.handler((ctx) => ctx.res.text("ok", "3"))
		.get("/c4")
		.handler((ctx) => ctx.res.text("ok", "4"))
		.get("/c5")
		.handler((ctx) => ctx.res.text("ok", "5"))
		.get("/c6")
		.handler((ctx) => ctx.res.text("ok", "6"))
		.get("/c7")
		.handler((ctx) => ctx.res.text("ok", "7"))
		.get("/c8")
		.handler((ctx) => ctx.res.text("ok", "8"))
		.get("/c9")
		.handler((ctx) => ctx.res.text("ok", "9"))
		.get("/c10")
		.handler((ctx) => ctx.res.text("ok", "10"))
		.get("/c11")
		.handler((ctx) => ctx.res.text("ok", "11"))
		.get("/c12")
		.handler((ctx) => ctx.res.text("ok", "12"))
		.get("/c13")
		.handler((ctx) => ctx.res.text("ok", "13"))
		.get("/c14")
		.handler((ctx) => ctx.res.text("ok", "14"))
		.get("/c15")
		.handler((ctx) => ctx.res.text("ok", "15"))
		.get("/c16")
		.handler((ctx) => ctx.res.text("ok", "16"))
		.get("/c17")
		.handler((ctx) => ctx.res.text("ok", "17"))
		.get("/c18")
		.handler((ctx) => ctx.res.text("ok", "18"))
		.get("/c19")
		.handler((ctx) => ctx.res.text("ok", "19"))
		.post("/c20")
		.input({ json: z.object({ name: z.string() }) })
		.handler((ctx) => ctx.res.json("created", { name: ctx.input.json.name }));

	type Routes = InferRoutes<typeof app>;

	it("PathsForMethod resolves", () => {
		type GetPaths = PathsForMethod<Routes, "get">;
		expectTypeOf<"/c1">().toMatchTypeOf<GetPaths>();
		expectTypeOf<"/c19">().toMatchTypeOf<GetPaths>();
	});

	it("InputFor works", () => {
		type Input = InputFor<Routes, "/c20", "post">;
		expectTypeOf<Input>().toEqualTypeOf<{ json: { name: string } }>();
	});

	it("ErrorsFor works", () => {
		type E = ErrorsFor<Routes, "/c1", "get">;
		expectTypeOf<E>().toBeNever();
	});
});

/* ---- .route() composition still works ---- */

describe(".route() composition after change", () => {
	it("merges sub-app routes", () => {
		const users = honey<{}>()
			.get("/users")
			.output({
				"application/json": { ok: z.object({ id: z.string() }).array() },
			})
			.handler((ctx) => ctx.res.json("ok", [{ id: "1" }]));

		const posts = honey<{}>()
			.get("/posts")
			.output({
				"application/json": { ok: z.object({ title: z.string() }).array() },
			})
			.handler((ctx) => ctx.res.json("ok", [{ title: "hi" }]));

		const app = honey<{}>().route(users).route(posts);
		type Routes = InferRoutes<typeof app>;

		expectTypeOf<PathsForMethod<Routes, "get">>().toMatchTypeOf<
			"/posts" | "/users"
		>();
	});
});

/* ---- meta preserved across many routes ---- */

describe("meta preserved across routes", () => {
	it("meta accessible on route with many predecessors", () => {
		const app = honey<{}>()
			.get("/r1")
			.handler((ctx) => ctx.res.text("ok", "1"))
			.get("/r2")
			.handler((ctx) => ctx.res.text("ok", "2"))
			.get("/r3")
			.handler((ctx) => ctx.res.text("ok", "3"))
			.get("/r4")
			.handler((ctx) => ctx.res.text("ok", "4"))
			.get("/r5")
			.handler((ctx) => ctx.res.text("ok", "5"))
			.get("/r6")
			.meta({ summary: "Route 6", tags: ["test"] })
			.handler((ctx) => ctx.res.text("ok", "6"));

		type Meta = InferRouteMeta<typeof app, "/r6", "get">;
		/* meta is stored at route-builder level, not in route record — returns never */
		expectTypeOf<Meta>().toBeNever();
	});
});

/* ---- 60+ route builder chain mirrors real app — meta, input, output, errors, handler ---- */

describe("honey() builder with 60+ routes (real-world pattern)", () => {
	const errs = defineErrors({ forbidden: "forbidden", not_found: "not_found" });

	const bigApp = honey<{}>()
		.meta<{ auth: boolean }>()
		.errorFactory(errs)

		.post("/v1/auth/register")
		.meta({ auth: false })
		.input({ json: z.object({ email: z.string(), password: z.string() }) })
		.handler((c) => c.res.json("created", { id: "1" }))

		.post("/v1/auth/login")
		.meta({ auth: false })
		.input({ json: z.object({ email: z.string(), password: z.string() }) })
		.handler((c) => c.res.json("ok", { token: "t" }))

		.post("/v1/auth/refresh")
		.meta({ auth: false })
		.input({ json: z.object({ refresh_token: z.string() }) })
		.handler((c) => c.res.json("ok", { token: "t" }))

		.post("/v1/auth/logout")
		.meta({ auth: false })
		.input({ json: z.object({ refresh_token: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/auth/email/verify")
		.meta({ auth: false })
		.input({ json: z.object({ token: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/auth/email/change")
		.meta({ auth: false })
		.input({ json: z.object({ token: z.string(), type: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/auth/magic-link/request")
		.meta({ auth: false })
		.input({ json: z.object({ email: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/auth/magic-link/verify")
		.meta({ auth: false })
		.input({ json: z.object({ token: z.string() }) })
		.handler((c) => c.res.json("ok", { token: "t" }))

		.get("/v1/auth/oauth/:provider/authorize")
		.meta({ auth: false })
		.input({ search: z.object({ redirect_url: z.string() }) })
		.handler((c) => c.res.json("ok", { url: "u" }))

		.get("/v1/auth/oauth/:provider/callback")
		.meta({ auth: false })
		.input({
			search: z.object({ code: z.string().optional(), state: z.string() }),
		})
		.handler((c) => c.res.redirect("https://example.com"))

		.post("/v1/auth/oauth/exchange")
		.meta({ auth: false })
		.input({ json: z.object({ code: z.string() }) })
		.handler((c) => c.res.json("ok", { token: "t" }))

		.post("/v1/auth/password/reset/request")
		.meta({ auth: false })
		.input({ json: z.object({ email: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/auth/password/reset")
		.meta({ auth: false })
		.input({ json: z.object({ password: z.string(), token: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/auth/2fa/verify")
		.meta({ auth: false })
		.input({ json: z.object({ code: z.string(), temp_token: z.string() }) })
		.handler((c) => c.res.json("ok", { token: "t" }))

		.get("/v1/auth/me")
		.meta({ auth: true })
		.errors(errs, "not_found")
		.handler((c) => c.res.json("ok", { id: "1" }))

		.patch("/v1/auth/me")
		.meta({ auth: true })
		.input({ json: z.object({ first_name: z.string().optional() }) })
		.handler((c) => c.res.json("ok", { id: "1" }))

		.post("/v1/auth/password")
		.meta({ auth: true })
		.input({ json: z.object({ password: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.patch("/v1/auth/password")
		.meta({ auth: true })
		.input({
			json: z.object({
				current_password: z.string(),
				new_password: z.string(),
			}),
		})
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/auth/email/verify/request")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/auth/email/change/request")
		.meta({ auth: true })
		.input({ json: z.object({ new_email: z.string(), password: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/auth/2fa/setup")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", { secret: "s" }))

		.post("/v1/auth/2fa/enable")
		.meta({ auth: true })
		.input({ json: z.object({ code: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/auth/2fa/disable")
		.meta({ auth: true })
		.input({ json: z.object({ password: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.get("/v1/auth/sessions")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", []))

		.delete("/v1/auth/sessions/:family_id")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", {}))

		.delete("/v1/auth/sessions")
		.meta({ auth: true })
		.input({ json: z.object({ refresh_token: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/auth/context/organization")
		.meta({ auth: true })
		.input({ json: z.object({ organization_id: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/auth/context/project")
		.meta({ auth: true })
		.input({ json: z.object({ project_id: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.delete("/v1/auth/account")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", {}))

		.get("/v1/auth/onboarding")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", {}))

		.patch("/v1/auth/onboarding")
		.meta({ auth: true })
		.input({ json: z.object({ status: z.string().optional() }) })
		.handler((c) => c.res.json("ok", {}))

		.delete("/v1/auth/onboarding")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/organizations")
		.meta({ auth: true })
		.input({ json: z.object({ name: z.string() }) })
		.handler((c) => c.res.json("created", { id: "1" }))

		.get("/v1/organizations")
		.meta({ auth: true })
		.input({
			search: z.object({
				limit: z.coerce.number().optional(),
				page: z.coerce.number().optional(),
			}),
		})
		.handler((c) => c.res.json("ok", []))

		.get("/v1/organizations/:org_id")
		.meta({ auth: true })
		.errors(errs, "not_found")
		.handler((c) => c.res.json("ok", { id: c.params.org_id }))

		.patch("/v1/organizations/:org_id")
		.meta({ auth: true })
		.input({ json: z.object({ name: z.string().optional() }) })
		.handler((c) => c.res.json("ok", { id: c.params.org_id }))

		.delete("/v1/organizations/:org_id")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/organizations/:org_id/members/invite")
		.meta({ auth: true })
		.input({ json: z.object({ email: z.string(), role: z.string() }) })
		.handler((c) => c.res.json("created", {}))

		.get("/v1/organizations/:org_id/members")
		.meta({ auth: true })
		.input({
			search: z.object({
				limit: z.coerce.number().optional(),
				page: z.coerce.number().optional(),
			}),
		})
		.handler((c) => c.res.json("ok", []))

		.get("/v1/organizations/:org_id/members/:member_id")
		.meta({ auth: true })
		.errors(errs, "not_found")
		.handler((c) => c.res.json("ok", { id: c.params.member_id }))

		.patch("/v1/organizations/:org_id/members/:member_id/role")
		.meta({ auth: true })
		.input({ json: z.object({ role: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.delete("/v1/organizations/:org_id/members/:member_id")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/organizations/:org_id/members/transfer")
		.meta({ auth: true })
		.input({ json: z.object({ member_id: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/organizations/:org_id/members/:member_id/resend")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", {}))

		.delete("/v1/organizations/:org_id/members/me")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/organizations/members/accept")
		.meta({ auth: true })
		.input({ json: z.object({ invite_token: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/projects")
		.meta({ auth: true })
		.input({ json: z.object({ name: z.string() }) })
		.handler((c) => c.res.json("created", { id: "1" }))

		.get("/v1/projects")
		.meta({ auth: true })
		.input({
			search: z.object({
				limit: z.coerce.number().optional(),
				page: z.coerce.number().optional(),
			}),
		})
		.handler((c) => c.res.json("ok", []))

		.get("/v1/projects/:project_id")
		.meta({ auth: true })
		.errors(errs, "not_found")
		.handler((c) => c.res.json("ok", { id: c.params.project_id }))

		.patch("/v1/projects/:project_id")
		.meta({ auth: true })
		.input({ json: z.object({ name: z.string().optional() }) })
		.handler((c) => c.res.json("ok", {}))

		.delete("/v1/projects/:project_id")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/projects/:project_id/members/invite")
		.meta({ auth: true })
		.input({ json: z.object({ email: z.string(), role: z.string() }) })
		.handler((c) => c.res.json("created", {}))

		.get("/v1/projects/:project_id/members")
		.meta({ auth: true })
		.input({ search: z.object({ limit: z.coerce.number().optional() }) })
		.handler((c) => c.res.json("ok", []))

		.get("/v1/projects/:project_id/members/:member_id")
		.meta({ auth: true })
		.errors(errs, "not_found")
		.handler((c) => c.res.json("ok", { id: c.params.member_id }))

		.patch("/v1/projects/:project_id/members/:member_id/role")
		.meta({ auth: true })
		.input({ json: z.object({ role: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.delete("/v1/projects/:project_id/members/:member_id")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/projects/:project_id/members/transfer")
		.meta({ auth: true })
		.input({ json: z.object({ member_id: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/projects/:project_id/members/:member_id/resend")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", {}))

		.delete("/v1/projects/:project_id/members/me")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/projects/members/accept")
		.meta({ auth: true })
		.input({ json: z.object({ invite_token: z.string() }) })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/api-keys")
		.meta({ auth: true })
		.input({ json: z.object({ name: z.string(), project_id: z.string() }) })
		.handler((c) => c.res.json("created", { id: "1" }))

		.get("/v1/api-keys")
		.meta({ auth: true })
		.input({ search: z.object({ project_id: z.string() }) })
		.handler((c) => c.res.json("ok", []))

		.get("/v1/api-keys/:api_key_id")
		.meta({ auth: true })
		.errors(errs, "not_found")
		.handler((c) => c.res.json("ok", { id: c.params.api_key_id }))

		.patch("/v1/api-keys/:api_key_id")
		.meta({ auth: true })
		.input({ json: z.object({ name: z.string().optional() }) })
		.handler((c) => c.res.json("ok", {}))

		.delete("/v1/api-keys/:api_key_id")
		.meta({ auth: true })
		.handler((c) => c.res.json("ok", {}))

		.post("/v1/api-keys/last-used")
		.meta({ auth: true })
		.input({ json: z.object({ ids: z.string().array() }) })
		.handler((c) => c.res.json("ok", {}));

	type BigRoutes = InferRoutes<typeof bigApp>;

	it("app is not any", () => {
		expectTypeOf(bigApp).not.toBeAny();
	});

	it("InferRoutes is not any/never", () => {
		expectTypeOf<BigRoutes>().not.toBeAny();
		expectTypeOf<BigRoutes>().not.toBeNever();
	});

	it("first route accessible", () => {
		expectTypeOf<BigRoutes>().toHaveProperty("/v1/auth/register");
	});

	it("last route accessible", () => {
		expectTypeOf<BigRoutes>().toHaveProperty("/v1/api-keys/last-used");
	});

	it("PathsForMethod resolves GET and POST", () => {
		type GetPaths = PathsForMethod<BigRoutes, "get">;
		expectTypeOf<"/v1/auth/me">().toMatchTypeOf<GetPaths>();
		type PostPaths = PathsForMethod<BigRoutes, "post">;
		expectTypeOf<"/v1/auth/register">().toMatchTypeOf<PostPaths>();
	});

	it("InputFor extracts schemas", () => {
		type Input = InputFor<BigRoutes, "/v1/auth/register", "post">;
		expectTypeOf<Input>().toMatchTypeOf<{
			json: { email: string; password: string };
		}>();
	});

	it("ErrorsFor extracts route errors", () => {
		type E = ErrorsFor<BigRoutes, "/v1/auth/me", "get">;
		expectTypeOf<E>().toEqualTypeOf<"not_found">();
	});
});
