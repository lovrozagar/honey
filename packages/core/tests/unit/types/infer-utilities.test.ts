import { describe, expectTypeOf, it } from "vitest";
import * as z from "zod";
import type {
	InferCtx,
	InferEnv,
	InferErrorFactory,
	InferMethods,
	InferRouteCtx,
	InferRouteErrors,
	InferRouteInput,
	InferRouteMethods,
	InferRouteOutput,
	InferRoutePaths,
	InferRoutes,
	MiddlewareFn,
} from "../../../src/index.ts";
import { defineErrors, type HoneyContext, honey } from "../../../src/index.ts";

/* ---- test fixtures ---- */

type TestEnv = { DB: unknown; SECRET: string };

type DbCtx = { db: { query: (sql: string) => unknown[] } };
const withDb: MiddlewareFn<{}, DbCtx> = async (_ctx, next) => {
	return next({ db: { query: () => [] } });
};

type AuthCtx = { orgId: string; userId: string };
const withAuth: MiddlewareFn<DbCtx & { req: Request }, AuthCtx> = async (
	_ctx,
	next,
) => {
	return next({ orgId: "org-1", userId: "u-1" });
};

/* ---- tests ---- */

describe("InferCtx", () => {
	it("extracts HoneyContext from bare instance", () => {
		const app = honey<TestEnv>();
		type Ctx = InferCtx<typeof app>;
		expectTypeOf<Ctx>().toMatchTypeOf<HoneyContext<TestEnv>>();
	});

	it("accumulates middleware additions via .use()", () => {
		const app = honey<TestEnv>().use(withDb);
		type Ctx = InferCtx<typeof app>;
		expectTypeOf<Ctx>().toMatchTypeOf<{
			db: { query: (sql: string) => unknown[] };
		}>();
	});

	it("accumulates multiple middleware in chain", () => {
		const base = honey<TestEnv>().use(withDb).use(withAuth);
		type Ctx = InferCtx<typeof base>;
		expectTypeOf<Ctx>().toMatchTypeOf<{
			db: { query: (sql: string) => unknown[] };
		}>();
		expectTypeOf<Ctx>().toMatchTypeOf<{ orgId: string; userId: string }>();
	});

	it("returns never for non-Honey types", () => {
		type Ctx = InferCtx<string>;
		expectTypeOf<Ctx>().toBeNever();
	});
});

describe("InferEnv", () => {
	it("extracts env type", () => {
		const app = honey<TestEnv>();
		type Env = InferEnv<typeof app>;
		expectTypeOf<Env>().toEqualTypeOf<TestEnv>();
	});

	it("preserves env through .use() chain", () => {
		const app = honey<TestEnv>().use(withDb);
		type Env = InferEnv<typeof app>;
		expectTypeOf<Env>().toEqualTypeOf<TestEnv>();
	});

	it("returns never for non-Honey types", () => {
		type Env = InferEnv<{ foo: string }>;
		expectTypeOf<Env>().toBeNever();
	});
});

describe("InferMethods", () => {
	it("extracts all methods used across all routes", () => {
		const app = honey<TestEnv>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.post("/users")
			.handler((ctx) => ctx.res.json("created", {}))
			.delete("/users/:id")
			.handler((ctx) => ctx.res.text("ok", ctx.params.id));

		type Methods = InferMethods<typeof app>;
		expectTypeOf<"get">().toMatchTypeOf<Methods>();
		expectTypeOf<"post">().toMatchTypeOf<Methods>();
		expectTypeOf<"delete">().toMatchTypeOf<Methods>();
	});

	it("deduplicates methods across paths", () => {
		const app = honey<TestEnv>()
			.get("/a")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.get("/b")
			.handler((ctx) => ctx.res.text("ok", "ok"));

		type Methods = InferMethods<typeof app>;
		expectTypeOf<"get">().toMatchTypeOf<Methods>();
	});
});

describe("InferRoutePaths & InferRouteMethods", () => {
	it("extracts registered path literals", () => {
		const app = honey<TestEnv>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.post("/users")
			.handler((ctx) => ctx.res.json("created", {}));

		type Paths = InferRoutePaths<typeof app>;
		expectTypeOf<"/health">().toMatchTypeOf<Paths>();
		expectTypeOf<"/users">().toMatchTypeOf<Paths>();
	});

	it("extracts registered methods for a path", () => {
		const app = honey<TestEnv>()
			.get("/users")
			.handler((ctx) => ctx.res.json("ok", []))
			.post("/users")
			.handler((ctx) => ctx.res.json("created", {}));

		type Methods = InferRouteMethods<typeof app, "/users">;
		expectTypeOf<"get">().toMatchTypeOf<Methods>();
		expectTypeOf<"post">().toMatchTypeOf<Methods>();
	});
});

describe("InferRouteInput", () => {
	it("extracts input type for route with input schema", () => {
		const app = honey<TestEnv>()
			.get("/search")
			.input({ search: z.object({ limit: z.string(), q: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { q: ctx.input.search.q }));

		type Input = InferRouteInput<typeof app, "/search", "get">;
		expectTypeOf<Input>().not.toBeUnknown();
		expectTypeOf<Input>().toEqualTypeOf<{
			search: { limit: string; q: string };
		}>();
	});

	it("works with explicit method", () => {
		const app = honey<TestEnv>()
			.get("/items")
			.input({ search: z.object({ page: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { page: ctx.input.search.page }));
		type Input = InferRouteInput<typeof app, "/items", "get">;
		expectTypeOf<Input>().toMatchTypeOf<{ search: { page: string } }>();
	});
});

describe("InferRouteOutput", () => {
	it("extracts output schema type", () => {
		const app = honey<TestEnv>()
			.get("/users")
			.output({
				"application/json": {
					ok: z.object({ id: z.string(), name: z.string() }),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { id: "1", name: "test" }));
		type Output = InferRouteOutput<typeof app, "/users", "get">;
		expectTypeOf<Output>().toHaveProperty("application/json");
	});
});

describe("InferRouteCtx", () => {
	it("extracts full handler context for a route", () => {
		const base = honey<TestEnv>().use(withDb).use(withAuth);
		const app = base
			.get("/orgs")
			.handler((ctx) =>
				ctx.res.json("ok", { orgs: ctx.db.query("SELECT * FROM orgs") }),
			);

		type Ctx = InferRouteCtx<typeof app, "/orgs", "get">;
		expectTypeOf<Ctx>().toMatchTypeOf<{
			db: { query: (sql: string) => unknown[] };
		}>();
		expectTypeOf<Ctx>().toMatchTypeOf<{ orgId: string; userId: string }>();
	});

	it("includes input when route has .input()", () => {
		const app = honey<TestEnv>()
			.get("/search")
			.input({ search: z.object({ q: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { q: ctx.input.search.q }));

		type Ctx = InferRouteCtx<typeof app, "/search", "get">;
		expectTypeOf<Ctx>().toMatchTypeOf<{ input: { search: { q: string } } }>();
	});

	it("includes typed params for parameterized routes", () => {
		const app = honey<TestEnv>()
			.get("/users/:userId")
			.handler((ctx) => ctx.res.text("ok", ctx.params.userId));

		type Ctx = InferRouteCtx<typeof app, "/users/:userId", "get">;
		expectTypeOf<Ctx>().toMatchTypeOf<{
			readonly params: { userId: string };
		}>();
	});

	it("works with post method", () => {
		const app = honey<TestEnv>()
			.post("/create")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", { name: ctx.input.json.name }));
		type Ctx = InferRouteCtx<typeof app, "/create", "post">;
		expectTypeOf<Ctx>().toMatchTypeOf<{ input: { json: { name: string } } }>();
	});

	it("path and method are constrained to registered routes", () => {
		const app = honey<TestEnv>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"));

		type _Valid = InferRouteCtx<typeof app, "/health", "get">;

		/* @ts-expect-error - "/nope" is not a registered route path */
		type _InvalidPath = InferRouteCtx<typeof app, "/nope", "get">;
		/* @ts-expect-error - "post" is not registered for /health */
		type _InvalidMethod = InferRouteCtx<typeof app, "/health", "post">;
		void (null as unknown as _Valid);
		void (null as unknown as _InvalidPath);
		void (null as unknown as _InvalidMethod);
	});
});

describe("InferRouteErrors", () => {
	it("extracts error keys from route with .errors()", () => {
		const errs = defineErrors({
			email_taken: "conflict",
			org_limit: "forbidden",
		});

		const app = honey<TestEnv>()
			.get("/test")
			.errors(errs, "email_taken", "org_limit")
			.handler((ctx) => ctx.res.text("ok", "ok"));

		type Errors = InferRouteErrors<typeof app, "/test", "get">;
		expectTypeOf<Errors>().toEqualTypeOf<"email_taken" | "org_limit">();
	});

	it("returns never for route without .errors()", () => {
		const app = honey<TestEnv>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"));

		type Errors = InferRouteErrors<typeof app, "/health", "get">;
		expectTypeOf<Errors>().toBeNever();
	});
});

describe("InferErrorFactory", () => {
	it("extracts error factory type from app with .errors(factory)", () => {
		const errs = defineErrors({
			email_taken: "conflict",
			org_limit: "forbidden",
		});

		const app = honey<TestEnv>().errorFactory(errs);
		type Factory = InferErrorFactory<typeof app>;
		expectTypeOf<Factory>().toMatchTypeOf<{
			email_taken: () => unknown;
			org_limit: () => unknown;
		}>();
	});

	it("returns never for app without .errors(factory)", () => {
		const app = honey<TestEnv>();
		type Factory = InferErrorFactory<typeof app>;
		expectTypeOf<Factory>().toBeNever();
	});
});

describe("architecture: base/routes/services split", () => {
	it("services can use InferCtx<typeof base> without circular deps", () => {
		const base = honey<TestEnv>().use(withDb).use(withAuth);
		type AppCtx = InferCtx<typeof base>;

		class OrgService {
			static list(ctx: AppCtx) {
				return ctx.db.query("SELECT * FROM orgs");
			}
		}

		const app = base.get("/orgs").handler((ctx) => {
			const result = OrgService.list(ctx);
			return ctx.res.json("ok", result);
		});

		type Routes = InferRoutes<typeof app>;
		expectTypeOf<Routes>().toHaveProperty("/orgs");
	});

	it("route-specific context available via InferRouteCtx after app is built", () => {
		const base = honey<TestEnv>().use(withDb).use(withAuth);
		const app = base
			.get("/orgs")
			.input({ search: z.object({ limit: z.string() }) })
			.handler((ctx) =>
				ctx.res.json("ok", {
					orgs: ctx.db.query(`limit: ${ctx.input.search.limit}`),
				}),
			);

		type OrgListCtx = InferRouteCtx<typeof app, "/orgs", "get">;
		expectTypeOf<OrgListCtx>().toMatchTypeOf<{
			db: { query: (sql: string) => unknown[] };
			input: { search: { limit: string } };
			orgId: string;
			userId: string;
		}>();
	});
});
