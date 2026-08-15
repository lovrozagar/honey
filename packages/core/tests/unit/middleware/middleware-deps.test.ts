import { describe, expectTypeOf, it } from "vitest";
import { createMiddleware, honey } from "../../../src/index.ts";
import type { MiddlewareFn } from "../../../src/middleware.ts";

describe("middleware dependency validation", () => {
	it("createMiddleware without TReqs works with any chain (backwards compat)", () => {
		const withAuth = createMiddleware(async (_ctx, next) => {
			return next({ userId: "anon" });
		});

		/* no dependencies — works on bare honey() */
		const app = honey().use(withAuth);
		app.get("/test").handler((ctx) => {
			expectTypeOf(ctx.userId).toEqualTypeOf<string>();
			return ctx.res.text("ok", "ok");
		});
	});

	it("createMiddleware with explicit TReqs enforces ordering at .use() call site", () => {
		type DbCtx = { db: { query: (sql: string) => unknown[] } };

		const withDb = createMiddleware(async (_ctx, next) =>
			next({
				db: {
					query: (sql: string) => {
						void sql;
						return [] as unknown[];
					},
				},
			}),
		);

		/* explicitly require db in context */
		const withAuth = createMiddleware<DbCtx, { userId: string }>(
			async (ctx, next) => {
				ctx.db.query("SELECT 1");
				return next({ userId: "u-1" });
			},
		);

		/* correct order: withDb adds db, then withAuth can use it */
		const app = honey().use(withDb).use(withAuth);
		app.get("/test").handler((ctx) => {
			expectTypeOf(ctx.userId).toEqualTypeOf<string>();
			expectTypeOf(ctx.db.query).toBeFunction();
			return ctx.res.text("ok", "ok");
		});
	});

	it("defineMiddleware with MiddlewareFn type enforces ordering", () => {
		type DbCtx = { db: { query: (sql: string) => unknown[] } };

		const withDb = createMiddleware(async (_ctx, next) =>
			next({
				db: {
					query: (sql: string) => {
						void sql;
						return [] as unknown[];
					},
				},
			}),
		);

		/* explicit MiddlewareFn type — requires DbCtx */
		const withAuth: MiddlewareFn<DbCtx, { userId: string }> = async (
			ctx,
			next,
		) => {
			ctx.db.query("SELECT 1");
			return next({ userId: "u-1" });
		};

		/* correct order — compiles */
		const app = honey().use(withDb).use(withAuth);
		app.get("/test").handler((ctx) => {
			expectTypeOf(ctx.userId).toEqualTypeOf<string>();
			expectTypeOf(ctx.db.query).toBeFunction();
			return ctx.res.text("ok", "ok");
		});
	});

	it("parameter annotation enforces ordering at .use() call site", () => {
		type DbCtx = { db: { query: (sql: string) => unknown[] } }

		const withDb = createMiddleware(async (_ctx, next) =>
			next({
				db: {
					query: (sql: string) => {
						void sql
						return [] as unknown[]
					},
				},
			}),
		)

		const withAuth = createMiddleware(async (ctx: DbCtx, next) => {
			ctx.db.query("SELECT 1")
			return next({ userId: "u-1" })
		})

		const app = honey().use(withDb).use(withAuth)
		app.get("/test").handler((ctx) => {
			expectTypeOf(ctx.userId).toEqualTypeOf<string>()
			expectTypeOf(ctx.db.query).toBeFunction()
			return ctx.res.text("ok", "ok")
		})
	})

	it("rejects middleware whose ctx asserts properties not in chain", () => {
		type NeedsCache = { cache: Map<string, string> }

		const withCache = createMiddleware(async (_ctx, next) =>
			next({ cache: new Map<string, string>() }),
		)

		const withCachedUser = createMiddleware(async (ctx: NeedsCache, next) => {
			const name = ctx.cache.get("user")
			return next({ cachedName: name ?? "anon" })
		})

		/* wrong order: withCachedUser requires cache, but chain has no cache yet */
		expectTypeOf(
			honey().use(withCachedUser),
		).toBeNever()

		/* correct order: withCache provides cache first */
		const good = honey().use(withCache).use(withCachedUser)
		good.get("/test").handler((ctx) => {
			expectTypeOf(ctx.cachedName).toEqualTypeOf<string>()
			expectTypeOf(ctx.cache).toEqualTypeOf<Map<string, string>>()
			return ctx.res.text("ok", "ok")
		})
	})
});
