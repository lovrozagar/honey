import { describe, expect, it } from "vitest";
import { accepts } from "../../../src/accepts.ts";
import { honey } from "../../../src/index.ts";
import { testClient } from "../../../src/testing.ts";

/* ═══════════════════════════════════════════
 * testClient: cookie jar
 * ═══════════════════════════════════════════ */

describe("testClient: cookie jar", () => {
	it("collects Set-Cookie from response and sends on next request", async () => {
		const app = honey<{}>();
		app
			.get("/login")
			.handler((ctx) =>
				ctx.res.json(
					"ok",
					{ logged: true },
					{ cookies: { session: { value: "tok-123" } } },
				),
			);
		app.get("/me").handler((ctx) => {
			const session = ctx.cookies.session;
			return ctx.res.json("ok", { session: session ?? "none" });
		});

		const client = testClient(app, { cookies: true, env: {} });
		await client.get("/login");
		const res = await client.get("/me");
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.session).toBe("tok-123");
	});

	it("cookie jar disabled → cookies not forwarded", async () => {
		const app = honey<{}>();
		app
			.get("/login")
			.handler((ctx) =>
				ctx.res.json("ok", {}, { cookies: { session: { value: "tok" } } }),
			);
		app
			.get("/me")
			.handler((ctx) =>
				ctx.res.json("ok", { session: ctx.cookies.session ?? "none" }),
			);

		const client = testClient(app, { env: {} });
		await client.get("/login");
		const res = await client.get("/me");
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.session).toBe("none");
	});

	it("multiple cookies collected across requests", async () => {
		const app = honey<{}>();
		app
			.get("/step1")
			.handler((ctx) =>
				ctx.res.json("ok", {}, { cookies: { a: { value: "1" } } }),
			);
		app
			.get("/step2")
			.handler((ctx) =>
				ctx.res.json("ok", {}, { cookies: { b: { value: "2" } } }),
			);
		app
			.get("/check")
			.handler((ctx) =>
				ctx.res.json("ok", { a: ctx.cookies.a, b: ctx.cookies.b }),
			);

		const client = testClient(app, { cookies: true, env: {} });
		await client.get("/step1");
		await client.get("/step2");
		const res = await client.get("/check");
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.a).toBe("1");
		expect(data.b).toBe("2");
	});

	it("cookie overwritten by newer Set-Cookie", async () => {
		const app = honey<{}>();
		app
			.get("/set1")
			.handler((ctx) =>
				ctx.res.json("ok", {}, { cookies: { tok: { value: "old" } } }),
			);
		app
			.get("/set2")
			.handler((ctx) =>
				ctx.res.json("ok", {}, { cookies: { tok: { value: "new" } } }),
			);
		app
			.get("/check")
			.handler((ctx) => ctx.res.json("ok", { tok: ctx.cookies.tok }));

		const client = testClient(app, { cookies: true, env: {} });
		await client.get("/set1");
		await client.get("/set2");
		const res = await client.get("/check");
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.tok).toBe("new");
	});
});

/* ═══════════════════════════════════════════
 * accepts: content negotiation
 * ═══════════════════════════════════════════ */

describe("accepts: content negotiation", () => {
	it("exact match → returns matched type", () => {
		const req = new Request("http://localhost", {
			headers: { accept: "application/json" },
		});
		expect(accepts(req, ["application/json", "text/html"])).toBe(
			"application/json",
		);
	});

	it("wildcard */* → returns first supported", () => {
		const req = new Request("http://localhost", {
			headers: { accept: "*/*" },
		});
		expect(accepts(req, ["text/html", "application/json"])).toBe("text/html");
	});

	it("type wildcard text/* → matches text/html", () => {
		const req = new Request("http://localhost", {
			headers: { accept: "text/*" },
		});
		expect(accepts(req, ["application/json", "text/html"])).toBe("text/html");
	});

	it("no Accept header → returns first supported", () => {
		const req = new Request("http://localhost");
		expect(accepts(req, ["application/json"])).toBe("application/json");
	});

	it("q=0 explicitly rejects type", () => {
		const req = new Request("http://localhost", {
			headers: { accept: "text/html;q=0, application/json" },
		});
		expect(accepts(req, ["text/html", "application/json"])).toBe(
			"application/json",
		);
	});

	it("higher q value preferred", () => {
		const req = new Request("http://localhost", {
			headers: { accept: "text/html;q=0.5, application/json;q=0.9" },
		});
		expect(accepts(req, ["text/html", "application/json"])).toBe(
			"application/json",
		);
	});

	it("no match → returns null", () => {
		const req = new Request("http://localhost", {
			headers: { accept: "image/png" },
		});
		expect(accepts(req, ["application/json", "text/html"])).toBeNull();
	});

	it("empty supported list → returns null", () => {
		const req = new Request("http://localhost", {
			headers: { accept: "*/*" },
		});
		expect(accepts(req, [])).toBeNull();
	});

	it("multiple types with different q values", () => {
		const req = new Request("http://localhost", {
			headers: {
				accept: "text/html;q=0.1, application/json;q=0.8, text/plain;q=0.5",
			},
		});
		expect(accepts(req, ["text/html", "text/plain", "application/json"])).toBe(
			"application/json",
		);
	});

	it("case insensitive matching", () => {
		const req = new Request("http://localhost", {
			headers: { accept: "Application/JSON" },
		});
		expect(accepts(req, ["application/json"])).toBe("application/json");
	});

	it("accept with extra whitespace", () => {
		const req = new Request("http://localhost", {
			headers: { accept: "  text/html  ,  application/json  " },
		});
		expect(accepts(req, ["application/json"])).toBe("application/json");
	});

	it("empty accept header → returns first supported", () => {
		const req = new Request("http://localhost", {
			headers: { accept: "" },
		});
		expect(accepts(req, ["application/json"])).toBe("application/json");
	});
});

/* ═══════════════════════════════════════════
 * Response: cookie attributes in handler
 * ═══════════════════════════════════════════ */

describe("response: cookie attributes", () => {
	it("httpOnly cookie → Set-Cookie contains HttpOnly", async () => {
		const app = honey<{}>();
		app
			.get("/test")
			.handler((ctx) =>
				ctx.res.json(
					"ok",
					{},
					{ cookies: { sid: { httpOnly: true, value: "tok" } } },
				),
			);

		const res = await app.fetch(new Request("http://localhost/test"), {});
		const cookies = res.headers.getSetCookie();
		expect(cookies.some((c) => c.includes("HttpOnly"))).toBe(true);
	});

	it("secure cookie → Set-Cookie contains Secure", async () => {
		const app = honey<{}>();
		app
			.get("/test")
			.handler((ctx) =>
				ctx.res.json(
					"ok",
					{},
					{ cookies: { sid: { secure: true, value: "tok" } } },
				),
			);

		const res = await app.fetch(new Request("http://localhost/test"), {});
		const cookies = res.headers.getSetCookie();
		expect(cookies.some((c) => c.includes("Secure"))).toBe(true);
	});

	it("sameSite=strict → Set-Cookie contains SameSite=Strict", async () => {
		const app = honey<{}>();
		app
			.get("/test")
			.handler((ctx) =>
				ctx.res.json(
					"ok",
					{},
					{ cookies: { sid: { sameSite: "strict", value: "tok" } } },
				),
			);

		const res = await app.fetch(new Request("http://localhost/test"), {});
		const cookies = res.headers.getSetCookie();
		expect(cookies.some((c) => c.includes("SameSite=Strict"))).toBe(true);
	});

	it("maxAge → Set-Cookie contains Max-Age", async () => {
		const app = honey<{}>();
		app
			.get("/test")
			.handler((ctx) =>
				ctx.res.json(
					"ok",
					{},
					{ cookies: { sid: { maxAge: 3600, value: "tok" } } },
				),
			);

		const res = await app.fetch(new Request("http://localhost/test"), {});
		const cookies = res.headers.getSetCookie();
		expect(cookies.some((c) => c.includes("Max-Age=3600"))).toBe(true);
	});

	it("path + domain → Set-Cookie contains both", async () => {
		const app = honey<{}>();
		app
			.get("/test")
			.handler((ctx) =>
				ctx.res.json(
					"ok",
					{},
					{
						cookies: {
							sid: { domain: "example.com", path: "/app", value: "tok" },
						},
					},
				),
			);

		const res = await app.fetch(new Request("http://localhost/test"), {});
		const cookies = res.headers.getSetCookie();
		const sid = cookies.find((c) => c.startsWith("sid="));
		expect(sid).toContain("Path=/app");
		expect(sid).toContain("Domain=example.com");
	});

	it("multiple cookies with different attributes", async () => {
		const app = honey<{}>();
		app.get("/test").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: {
						csrf: { sameSite: "strict", value: "csrf-tok" },
						session: {
							httpOnly: true,
							maxAge: 86400,
							secure: true,
							value: "sess-tok",
						},
					},
				},
			),
		);

		const res = await app.fetch(new Request("http://localhost/test"), {});
		const cookies = res.headers.getSetCookie();
		expect(cookies.length).toBe(2);

		const session = cookies.find((c) => c.startsWith("session="));
		expect(session).toContain("HttpOnly");
		expect(session).toContain("Secure");
		expect(session).toContain("Max-Age=86400");

		const csrf = cookies.find((c) => c.startsWith("csrf="));
		expect(csrf).toContain("SameSite=Strict");
	});
});

/* ═══════════════════════════════════════════
 * Response: all content types
 * ═══════════════════════════════════════════ */

describe("response: content type methods", () => {
	it("res.xml → application/xml", async () => {
		const app = honey<{}>();
		app.get("/test").handler((ctx) => ctx.res.xml("ok", "<root/>"));
		const res = await app.fetch(new Request("http://localhost/test"), {});
		expect(res.headers.get("content-type")).toContain("application/xml");
		expect(await res.text()).toBe("<root/>");
	});

	it("res.csv → text/csv", async () => {
		const app = honey<{}>();
		app.get("/test").handler((ctx) => ctx.res.csv("ok", "a,b\n1,2"));
		const res = await app.fetch(new Request("http://localhost/test"), {});
		expect(res.headers.get("content-type")).toContain("text/csv");
		expect(await res.text()).toBe("a,b\n1,2");
	});

	it("res.html → text/html", async () => {
		const app = honey<{}>();
		app.get("/test").handler((ctx) => ctx.res.html("ok", "<h1>Hi</h1>"));
		const res = await app.fetch(new Request("http://localhost/test"), {});
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toBe("<h1>Hi</h1>");
	});

	it("res.text → text/plain", async () => {
		const app = honey<{}>();
		app.get("/test").handler((ctx) => ctx.res.text("ok", "hello"));
		const res = await app.fetch(new Request("http://localhost/test"), {});
		expect(res.headers.get("content-type")).toContain("text/plain");
	});

	it("res.binary → application/octet-stream", async () => {
		const app = honey<{}>();
		app
			.get("/test")
			.handler((ctx) => ctx.res.binary("ok", new Uint8Array([1, 2, 3])));
		const res = await app.fetch(new Request("http://localhost/test"), {});
		expect(res.headers.get("content-type")).toContain(
			"application/octet-stream",
		);
		const buf = await res.arrayBuffer();
		expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("res.json → application/json", async () => {
		const app = honey<{}>();
		app.get("/test").handler((ctx) => ctx.res.json("ok", { x: 1 }));
		const res = await app.fetch(new Request("http://localhost/test"), {});
		expect(res.headers.get("content-type")).toContain("application/json");
	});
});

/* ═══════════════════════════════════════════
 * Response: stream
 * ═══════════════════════════════════════════ */

describe("response: res.stream", () => {
	it("stream returns ReadableStream response via WritableStream callback", async () => {
		const app = honey<{}>();
		app.get("/stream").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter();
				const encoder = new TextEncoder();
				await writer.write(encoder.encode("chunk1"));
				await writer.write(encoder.encode("chunk2"));
				await writer.close();
			}),
		);

		const res = await app.fetch(new Request("http://localhost/stream"), {});
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("chunk1");
		expect(text).toContain("chunk2");
	});

	it("stream with custom headers", async () => {
		const app = honey<{}>();
		app.get("/stream").handler((ctx) =>
			ctx.res.stream(
				async (writable) => {
					const writer = writable.getWriter();
					await writer.write(new TextEncoder().encode("data"));
					await writer.close();
				},
				{ headers: { "x-stream": "true" } },
			),
		);

		const res = await app.fetch(new Request("http://localhost/stream"), {});
		expect(res.headers.get("x-stream")).toBe("true");
	});
});

/* ═══════════════════════════════════════════
 * Error cause chain preservation
 * ═══════════════════════════════════════════ */

describe("error: cause chain preserved", () => {
	it("onError receives the original thrown error", async () => {
		let caughtError: unknown;
		const app = honey<{}>().onError((err) => {
			caughtError = err;
			return undefined;
		});
		app.get("/fail").handler(() => {
			throw new Error("root cause");
		});

		await app.fetch(new Request("http://localhost/fail"), {});
		expect(caughtError).toBeInstanceOf(Error);
		expect((caughtError as Error).message).toBe("root cause");
	});

	it("onError can inspect and return custom response based on error type", async () => {
		const app = honey<{}>().onError((err) => {
			if (err instanceof Error && err.message === "db connection lost") {
				return new Response(
					JSON.stringify({ error: "service_unavailable", retry: true }),
					{
						headers: { "content-type": "application/json" },
						status: 503,
					},
				);
			}
			return undefined;
		});
		app.get("/fail").handler(() => {
			throw new Error("db connection lost");
		});

		const res = await app.fetch(new Request("http://localhost/fail"), {});
		expect(res.status).toBe(503);
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.retry).toBe(true);
	});
});
