import { describe, expect, it } from "vitest";
import { HoneyContext } from "../../../src/context.ts";
import { honey } from "../../../src/index.ts";

describe("json circular reference", () => {
	it("circular object → 500, not unhandled crash", async () => {
		const app = honey<{}>();
		app.get("/circular").handler((ctx) => {
			const obj: Record<string, unknown> = { a: 1 };
			obj.self = obj;
			return ctx.res.json("ok", obj);
		});

		const res = await app.fetch(new Request("http://localhost/circular"), {});
		expect(res.status).toBe(500);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error_key).toBe("internal_server_error");
	});
});

describe("redirect edge cases", () => {
	it("redirect with valid URL works", async () => {
		const app = honey<{}>();
		app.get("/go").handler((ctx) => ctx.res.redirect("/destination"));

		const res = await app.fetch(new Request("http://localhost/go"), {});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/destination");
	});
});

describe("throw non-Error values", () => {
	it("throw string → 500 internal_server_error", async () => {
		const app = honey<{}>();
		app.get("/throw-string").handler(() => {
			throw "something went wrong";
		});

		const res = await app.fetch(
			new Request("http://localhost/throw-string"),
			{},
		);
		expect(res.status).toBe(500);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error_key).toBe("internal_server_error");
	});

	it("throw number → 500 internal_server_error", async () => {
		const app = honey<{}>();
		app.get("/throw-number").handler(() => {
			throw 42;
		});

		const res = await app.fetch(
			new Request("http://localhost/throw-number"),
			{},
		);
		expect(res.status).toBe(500);
	});

	it("throw null → 500 internal_server_error", async () => {
		const app = honey<{}>();
		app.get("/throw-null").handler(() => {
			throw null;
		});

		const res = await app.fetch(new Request("http://localhost/throw-null"), {});
		expect(res.status).toBe(500);
	});
});

describe("onError handler throws", () => {
	it("onError throwing → falls through to default error response", async () => {
		const app = honey<{}>();
		app.onError(() => {
			throw new Error("onError itself crashed");
		});
		app.get("/fail").handler(() => {
			throw new Error("original error");
		});

		const res = await app.fetch(new Request("http://localhost/fail"), {});
		/* should still return a response, not crash */
		expect(res.status).toBe(500);
	});
});

describe("optional param at root", () => {
	it("/:lang? matches both / and /en", async () => {
		const app = honey<{}>();
		app
			.get("/:lang?")
			.handler((ctx) =>
				ctx.res.json("ok", { lang: ctx.params.lang ?? "default" }),
			);

		const root = await app.fetch(new Request("http://localhost/"), {});
		expect(root.status).toBe(200);
		const rootBody = (await root.json()) as Record<string, unknown>;
		expect(rootBody.lang).toBe("default");

		const en = await app.fetch(new Request("http://localhost/en"), {});
		expect(en.status).toBe(200);
		const enBody = (await en.json()) as Record<string, unknown>;
		expect(enBody.lang).toBe("en");
	});
});

describe("search edge cases", () => {
	it("bare ? with no key-value → empty object", () => {
		const ctx = new HoneyContext({
			env: {},
			params: {},
			req: new Request("http://localhost/test?"),
		});
		expect(ctx.search).toEqual({});
	});

	it("key with no value ?key → empty string", () => {
		const ctx = new HoneyContext({
			env: {},
			params: {},
			req: new Request("http://localhost/test?key"),
		});
		expect(ctx.search.key).toBe("");
	});

	it("key with empty value ?key= → empty string", () => {
		const ctx = new HoneyContext({
			env: {},
			params: {},
			req: new Request("http://localhost/test?key="),
		});
		expect(ctx.search.key).toBe("");
	});
});

describe("GET without body", () => {
	it("GET request → handler works without body parsing", async () => {
		const app = honey<{}>();
		app.get("/test").handler((ctx) => ctx.res.text("ok", "works"));

		const res = await app.fetch(new Request("http://localhost/test"), {});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("works");
	});
});

describe("HEAD auto-handling with ALL handler", () => {
	it("HEAD to route with only ALL handler → 200, empty body", async () => {
		const app = honey<{}>();
		app
			.all("/catch-all")
			.handler((ctx) => ctx.res.json("ok", { method: ctx.req.method }));

		const res = await app.fetch(
			new Request("http://localhost/catch-all", { method: "HEAD" }),
			{},
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");
	});
});

describe("double slash in URL", () => {
	it("//health normalizes to /health", async () => {
		const app = honey<{}>();
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"));

		const res = await app.fetch(new Request("http://localhost//health"), {});
		expect(res.status).toBe(200);
	});
});
