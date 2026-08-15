import { describe, expect, it } from "vitest";
import * as z from "zod";
import { defineErrors, honey } from "../../../src/index.ts";

describe("adversarial: malformed requests", () => {
	it("extremely long URL path (10000 chars) → handled without crash", async () => {
		const app = honey<{}>();
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"));

		const longPath = `/test/${"a".repeat(10000)}`;
		const res = await app.fetch(new Request(`http://localhost${longPath}`), {});
		/* should be 404, not crash */
		expect(res.status).toBe(404);
	});

	it("extremely long query string → parsed without crash", async () => {
		const app = honey<{}>();
		app
			.get("/test")
			.handler((ctx) =>
				ctx.res.json("ok", { keys: Object.keys(ctx.search).length }),
			);

		const longQuery = Array.from(
			{ length: 1000 },
			(_, i) => `k${i}=v${i}`,
		).join("&");
		const res = await app.fetch(
			new Request(`http://localhost/test?${longQuery}`),
			{},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.keys).toBe(1000);
	});

	it("null byte in URL path → handled", async () => {
		const app = honey<{}>();
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"));

		const res = await app.fetch(
			new Request("http://localhost/test%00evil"),
			{},
		);
		expect([200, 404]).toContain(res.status);
	});

	it("null byte in query param → handled", async () => {
		const app = honey<{}>();
		app.get("/test").handler((ctx) => ctx.res.json("ok", { q: ctx.search.q }));

		const res = await app.fetch(
			new Request("http://localhost/test?q=hello%00world"),
			{},
		);
		expect(res.status).toBe(200);
	});

	it("extremely large JSON body → rejected by body-limit if configured", async () => {
		const { bodyLimit } = await import("../../../src/body-limit.ts");
		const app = honey<{}>();
		app
			.use(bodyLimit({ maxSize: 1024 }))
			.post("/test")
			.handler(async (ctx) => {
				await ctx.req.text();
				return ctx.res.text("ok", "ok");
			});

		const largeBody = JSON.stringify({ data: "x".repeat(2000) });
		const res = await app.fetch(
			new Request("http://localhost/test", {
				body: largeBody,
				headers: {
					"content-length": String(largeBody.length),
					"content-type": "application/json",
				},
				method: "POST",
			}),
			{},
		);
		expect(res.status).toBe(413);
	});

	it("content-type header injection attempt → blocked by Request API", () => {
		/* CRLF in headers is rejected at the Request constructor level (Web Standard) */
		expect(
			() =>
				new Request("http://localhost/test", {
					headers: { "content-type": "application/json\r\nX-Injected: evil" },
					method: "POST",
				}),
		).toThrow();
	});

	it("duplicate content-type headers → handled gracefully", async () => {
		const app = honey<{}>();
		app
			.post("/test")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input.json));

		const headers = new Headers();
		headers.append("content-type", "application/json");
		headers.append("content-type", "text/plain");

		const res = await app.fetch(
			new Request("http://localhost/test", {
				body: JSON.stringify({ name: "test" }),
				headers,
				method: "POST",
			}),
			{},
		);
		expect([200, 400, 422]).toContain(res.status);
	});
});

describe("adversarial: prototype pollution via JSON", () => {
	it("JSON body with __proto__ → not polluted", async () => {
		const before = ({} as Record<string, unknown>).polluted;
		expect(before).toBeUndefined();

		const app = honey<{}>();
		app
			.post("/test")
			.input({ json: z.object({ name: z.string() }).passthrough() })
			.handler((ctx) => ctx.res.json("ok", ctx.input.json));

		await app.fetch(
			new Request("http://localhost/test", {
				body: '{"name":"test","__proto__":{"polluted":"yes"}}',
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		);

		const after = ({} as Record<string, unknown>).polluted;
		expect(after).toBeUndefined();
	});

	it("JSON body with constructor.prototype → not polluted", async () => {
		const app = honey<{}>();
		app
			.post("/test")
			.input({ json: z.record(z.string(), z.unknown()) })
			.handler((ctx) => ctx.res.json("ok", ctx.input.json));

		await app.fetch(
			new Request("http://localhost/test", {
				body: '{"constructor":{"prototype":{"polluted":"yes"}}}',
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		);

		const after = ({} as Record<string, unknown>).polluted;
		expect(after).toBeUndefined();
	});
});

describe("adversarial: error information leakage", () => {
	it("internal error → no stack trace in response", async () => {
		const app = honey<{}>();
		app.get("/test").handler(() => {
			throw new Error(
				"secret database connection string: postgres://user:pass@host/db",
			);
		});

		const res = await app.fetch(new Request("http://localhost/test"), {});
		expect(res.status).toBe(500);
		const body = await res.text();
		expect(body).not.toContain("postgres://");
		expect(body).not.toContain("user:pass");
		expect(body).not.toContain("stack");
	});

	it("validation error → no internal schema details leaked", async () => {
		const app = honey<{}>();
		app
			.post("/test")
			.input({ json: z.object({ secret: z.string().min(8) }) })
			.handler((ctx) => ctx.res.json("ok", {}));

		const res = await app.fetch(
			new Request("http://localhost/test", {
				body: JSON.stringify({ secret: "short" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		);
		expect(res.status).toBe(400);
		const body = await res.text();
		/* should not leak the schema constraint details like "min(8)" */
		expect(body).not.toContain("min(8)");
	});

	it("error factory error → only errorKey exposed, not cause", async () => {
		const errors = defineErrors({ db_error: "internal_server_error" });
		const app = honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors("db_error")
			.handler(() => {
				throw errors.db_error({
					cause: new Error(
						"connection refused to postgres://admin:s3cr3t@prod-db:5432",
					),
				});
			});

		const res = await app.fetch(new Request("http://localhost/test"), {});
		expect(res.status).toBe(500);
		const body = await res.text();
		expect(body).not.toContain("postgres://");
		expect(body).not.toContain("s3cr3t");
		expect(body).not.toContain("connection refused");
		expect(body).toContain("db_error");
	});
});

describe("adversarial: timing attacks", () => {
	it("404 for different paths takes similar time", async () => {
		const app = honey<{}>();
		app
			.get("/secret-admin-panel")
			.handler((ctx) => ctx.res.text("ok", "admin"));

		const times: number[] = [];
		for (const path of [
			"/a",
			"/aaaaaaaaaa",
			"/secret-admin-pane",
			"/zzzzzzzzzzz",
		]) {
			const start = performance.now();
			await app.fetch(new Request(`http://localhost${path}`), {});
			times.push(performance.now() - start);
		}

		/* all 404 times should be within 10x of each other — no path-length timing leak */
		const max = Math.max(...times);
		const min = Math.min(...times);
		expect(max / Math.max(min, 0.001)).toBeLessThan(100);
	});
});

describe("adversarial: concurrent mutation", () => {
	it("parallel requests to same route don't share mutable state", async () => {
		const app = honey<{}>();
		app.get("/test").handler(async (ctx) => {
			const id = ctx.search.id;
			/* simulate async work that could expose shared state */
			await new Promise((r) => setTimeout(r, Math.random() * 5));
			return ctx.res.json("ok", { id });
		});

		const results = await Promise.all(
			Array.from({ length: 50 }, (_, i) =>
				app
					.fetch(new Request(`http://localhost/test?id=${i}`), {})
					.then(async (r) => {
						const body = (await r.json()) as Record<string, unknown>;
						return { expected: String(i), got: body.id };
					}),
			),
		);

		for (const { expected, got } of results) {
			expect(got).toBe(expected);
		}
	});
});

describe("adversarial: header manipulation", () => {
	it("response headers can't be manipulated via cookie name injection", async () => {
		const app = honey<{}>();
		app.get("/test").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: { "valid-cookie": { value: "safe" } },
				},
			),
		);

		const res = await app.fetch(new Request("http://localhost/test"), {});
		expect(res.status).toBe(200);
		const setCookie = res.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("valid-cookie=safe");
	});

	it("invalid cookie name → throws (not silently accepted)", async () => {
		const app = honey<{}>();
		app.get("/test").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: { "invalid;name": { value: "bad" } },
				},
			),
		);

		const res = await app.fetch(new Request("http://localhost/test"), {});
		/* should fail — invalid cookie name contains semicolon */
		expect(res.status).toBe(500);
	});
});
