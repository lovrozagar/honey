import { describe, expect, it } from "vitest";
import * as z from "zod";
import { defineErrors } from "../../../src/errors.ts";
import { honey } from "../../../src/index.ts";

/* ═══════════════════════════════════════════
 * Error boundaries: undeclared errors
 * ═══════════════════════════════════════════ */

describe("error boundary: undeclared errors wrapped", () => {
	it("undeclared HoneyError wrapped by defaultBoundary", async () => {
		const errors = defineErrors({
			boundary: "internal_server_error",
			known: "bad_request",
			surprise: "conflict",
		});

		const app = honey<{}>().errorFactory(errors).defaultBoundary("boundary");
		app
			.get("/fail")
			.errors("known")
			.handler(() => {
				/* throw error not declared on route — only "known" is declared */
				throw errors.surprise();
			});

		const res = await app.fetch(new Request("http://localhost/fail"), {});
		expect(res.status).toBe(500);
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.error_key).toBe("boundary");
	});

	it("undeclared plain Error wrapped by defaultBoundary", async () => {
		const errors = defineErrors({
			boundary: "internal_server_error",
		});

		const app = honey<{}>().errorFactory(errors).defaultBoundary("boundary");
		app.get("/crash").handler(() => {
			throw new Error("unexpected");
		});

		const res = await app.fetch(new Request("http://localhost/crash"), {});
		expect(res.status).toBe(500);
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.error_key).toBe("boundary");
	});

	it("declared error passes through without wrapping", async () => {
		const errors = defineErrors({
			boundary: "internal_server_error",
			not_found: "not_found",
		});

		const app = honey<{}>().errorFactory(errors).defaultBoundary("boundary");
		app
			.get("/miss")
			.errors("not_found")
			.handler(() => {
				throw errors.not_found();
			});

		const res = await app.fetch(new Request("http://localhost/miss"), {});
		expect(res.status).toBe(404);
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.error_key).toBe("not_found");
	});

	it("no boundary + undeclared error → generic 500", async () => {
		const errors = defineErrors({
			known: "bad_request",
			surprise: "conflict",
		});

		const app = honey<{}>().errorFactory(errors);
		app
			.get("/fail")
			.errors("known")
			.handler(() => {
				throw errors.surprise();
			});

		const res = await app.fetch(new Request("http://localhost/fail"), {});
		expect(res.status).toBe(500);
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.error_key).toBe("internal_server_error");
	});
});

/* ═══════════════════════════════════════════
 * Output validation modes
 * ═══════════════════════════════════════════ */

describe("output validation: content-type mismatch", () => {
	it("handler returns text but output declares json → 500 content-type mismatch", async () => {
		const app = honey<{}>().outputValidation("always");
		app
			.get("/data")
			.output({ "application/json": { ok: z.object({ id: z.number() }) } })
			.handler((ctx) =>
				ctx.res.raw(
					new Response("not json", {
						headers: { "content-type": "text/plain" },
					}),
				),
			);

		const res = await app.fetch(new Request("http://localhost/data"), {});
		expect(res.status).toBe(500);
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.error_key).toBe("output_content_type_mismatch");
	});
});

describe("output validation: schema mismatch", () => {
	it("handler returns wrong shape → 500 output_validation_failed", async () => {
		const app = honey<{}>().outputValidation("always");
		app
			.get("/data")
			.output({ "application/json": { ok: z.object({ id: z.number() }) } })
			.handler((ctx) =>
				/* wrong shape: name instead of id */
				ctx.res.json("ok", { name: "wrong" } as unknown as { id: number }),
			);

		const res = await app.fetch(new Request("http://localhost/data"), {});
		expect(res.status).toBe(500);
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.error_key).toBe("output_validation_failed");
	});

	it("valid output passes through unchanged", async () => {
		const app = honey<{}>().outputValidation("always");
		app
			.get("/data")
			.output({ "application/json": { ok: z.object({ id: z.number() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: 42 }));

		const res = await app.fetch(new Request("http://localhost/data"), {});
		expect(res.status).toBe(200);
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.id).toBe(42);
	});

	it("outputValidation off → invalid output passes through", async () => {
		const app = honey<{}>().outputValidation("off");
		app
			.get("/data")
			.output({ "application/json": { ok: z.object({ id: z.number() }) } })
			.handler((ctx) =>
				ctx.res.json("ok", { name: "wrong" } as unknown as { id: number }),
			);

		const res = await app.fetch(new Request("http://localhost/data"), {});
		expect(res.status).toBe(200);
	});
});

/* ═══════════════════════════════════════════
 * ctx.routePattern
 * ═══════════════════════════════════════════ */

describe("ctx.routePattern", () => {
	it("static route → pattern matches path", async () => {
		const app = honey<{}>();
		app
			.get("/users")
			.handler((ctx) => ctx.res.json("ok", { pattern: ctx.routePattern }));

		const res = await app.fetch(new Request("http://localhost/users"), {});
		const data = (await res.json()) as Record<string, string>;
		expect(data.pattern).toBe("/users");
	});

	it("param route → pattern contains :param", async () => {
		const app = honey<{}>();
		app
			.get("/users/:id")
			.handler((ctx) => ctx.res.json("ok", { pattern: ctx.routePattern }));

		const res = await app.fetch(new Request("http://localhost/users/42"), {});
		const data = (await res.json()) as Record<string, string>;
		expect(data.pattern).toBe("/users/:id");
	});

	it("wildcard route → pattern contains *", async () => {
		const app = honey<{}>();
		app
			.get("/files/*path")
			.handler((ctx) => ctx.res.json("ok", { pattern: ctx.routePattern }));

		const res = await app.fetch(
			new Request("http://localhost/files/a/b/c"),
			{},
		);
		const data = (await res.json()) as Record<string, string>;
		expect(data.pattern).toBe("/files/*path");
	});

	it("nested param route → full pattern preserved", async () => {
		const app = honey<{}>();
		app
			.get("/orgs/:orgId/users/:userId")
			.handler((ctx) => ctx.res.json("ok", { pattern: ctx.routePattern }));

		const res = await app.fetch(
			new Request("http://localhost/orgs/a/users/b"),
			{},
		);
		const data = (await res.json()) as Record<string, string>;
		expect(data.pattern).toBe("/orgs/:orgId/users/:userId");
	});
});

/* ═══════════════════════════════════════════
 * SSE: close() idempotent
 * ═══════════════════════════════════════════ */

describe("SSE: double close", () => {
	it("calling close() twice does not throw", async () => {
		const app = honey<{}>();
		app.get("/sse").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "x", event: "msg" });
				stream.close();
				stream.close();
			}),
		);

		const res = await app.fetch(new Request("http://localhost/sse"), {});
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("event: msg");
	});
});

/* ═══════════════════════════════════════════
 * Redirect: custom status codes
 * ═══════════════════════════════════════════ */

describe("redirect", () => {
	it("default redirect → 302", async () => {
		const app = honey<{}>();
		app.get("/old").handler((ctx) => ctx.res.redirect("/new"));

		const res = await app.fetch(new Request("http://localhost/old"), {});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/new");
	});

	it("permanent redirect → custom 301", async () => {
		const app = honey<{}>();
		app.get("/old").handler((ctx) => ctx.res.redirect("/new", { status: 301 }));

		const res = await app.fetch(new Request("http://localhost/old"), {});
		expect(res.status).toBe(301);
		expect(res.headers.get("location")).toBe("/new");
	});

	it("redirect with 308 permanent", async () => {
		const app = honey<{}>();
		app.get("/old").handler((ctx) => ctx.res.redirect("/new", { status: 308 }));

		const res = await app.fetch(new Request("http://localhost/old"), {});
		expect(res.status).toBe(308);
	});

	it("redirect body is null", async () => {
		const app = honey<{}>();
		app.get("/old").handler((ctx) => ctx.res.redirect("/new"));

		const res = await app.fetch(new Request("http://localhost/old"), {});
		const body = await res.text();
		expect(body).toBe("");
	});
});

/* ═══════════════════════════════════════════
 * noContent: 204 with no body
 * ═══════════════════════════════════════════ */

describe("noContent", () => {
	it("returns 204 with empty body", async () => {
		const app = honey<{}>();
		app.delete("/item").handler((ctx) => ctx.res.noContent());

		const res = await app.fetch(
			new Request("http://localhost/item", { method: "DELETE" }),
			{},
		);
		expect(res.status).toBe(204);
		const body = await res.text();
		expect(body).toBe("");
	});

	it("noContent with custom headers", async () => {
		const app = honey<{}>();
		app
			.delete("/item")
			.handler((ctx) =>
				ctx.res.noContent({ headers: { "x-deleted": "true" } }),
			);

		const res = await app.fetch(
			new Request("http://localhost/item", { method: "DELETE" }),
			{},
		);
		expect(res.status).toBe(204);
		expect(res.headers.get("x-deleted")).toBe("true");
	});
});
