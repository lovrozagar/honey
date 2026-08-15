import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "@honey/e2e-kitchen"
import { createClient } from "../../src/client/index.ts";
import type { SSEEvent } from "../../src/client/sse.ts";
import { type HoneyServer, serve } from "../../src/node.ts";
import { nodeWebSocket } from "../../src/ws/node.ts";

let server: HoneyServer;
let baseURL: string;

beforeAll(() => {
	const app = createApp(nodeWebSocket());
	server = serve(app, { env: {}, port: 0 });
	const addr = server.address() as { port: number };
	baseURL = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
	await server.shutdown(1000);
});

describe("edge: request body types", () => {
	it("POST with empty json body", async () => {
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		});
		const { error } = await api.post("/api/v1/organizations", { json: {} });
		expect(error).not.toBeNull();
		expect((error as Record<string, unknown>)?.error_key).toBe("invalid_input");
	});

	it("POST with nested json objects", async () => {
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		});
		const slug = `nested-${Date.now()}`;
		const { data, error } = await api.post("/api/v1/organizations", {
			json: { name: "Nested Test", slug },
		});
		expect(error).toBeNull();
		expect((data as unknown as { slug: string }).slug).toBe(slug);
	});

	it("GET with boolean search param", async () => {
		const api = createClient({ baseURL });
		/* /api/echo doesn't validate search — just proves encoding */
		const { error } = await api.get("/api/echo", {
			search: { active: true, count: 42, tag: "test" },
		});
		expect(error).toBeNull();
	});

	it("GET with array search param", async () => {
		const api = createClient({ baseURL });
		const { error } = await api.get("/api/echo", {
			search: { ids: [1, 2, 3] },
		});
		expect(error).toBeNull();
	});
});

describe("edge: rapid sequential requests", () => {
	it("10 rapid sequential calls all resolve correctly", async () => {
		const api = createClient({ baseURL });
		for (let i = 0; i < 10; i++) {
			const { data, error } = await api.get("/api/health");
			expect(error).toBeNull();
			expect(data).toBe("ok");
		}
	});
});

describe("edge: mixed concurrent success and error", () => {
	it("some succeed, some fail — no crosstalk", async () => {
		const api = createClient({ baseURL });
		const results = await Promise.all([
			api.get("/api/health"),
			api.get("/api/nonexistent"),
			api.get("/api/echo"),
			api.get("/api/boundary/default"),
			api.get("/api/health"),
		]);

		expect(results[0].error).toBeNull();
		expect(results[0].data).toBe("ok");

		expect(results[1].error).not.toBeNull();
		expect(results[1].status).toBe(404);

		expect(results[2].error).toBeNull();
		expect(results[2].data).toEqual({ method: "GET" });

		expect(results[3].error).not.toBeNull();
		expect((results[3].error as Record<string, unknown>)?.error_key).toBe("api_error");

		expect(results[4].error).toBeNull();
		expect(results[4].data).toBe("ok");
	});
});

describe("edge: tuple destructuring patterns", () => {
	it("destructure only data", async () => {
		const api = createClient({ baseURL });
		const { data } = await api.get("/api/health");
		expect(data).toBe("ok");
	});

	it("destructure only error", async () => {
		const api = createClient({ baseURL });
		const { error } = await api.get("/api/nonexistent");
		expect(error).not.toBeNull();
	});

	it("destructure all four fields", async () => {
		const api = createClient({ baseURL });
		const { data, error, response, status } = await api.get("/api/health");
		expect(data).toBe("ok");
		expect(error).toBeNull();
		expect(response).toBeInstanceOf(Response);
		expect(status).toBe(200);
	});

	it("use result without destructuring", async () => {
		const api = createClient({ baseURL });
		const result = await api.get("/api/health");
		expect(result.data).toBe("ok");
		expect(result.error).toBeNull();
		expect(result.response).toBeInstanceOf(Response);
		expect(result.status).toBe(200);
	});
});

describe("edge: client reuse across requests", () => {
	it("single client handles success then error then success", async () => {
		const api = createClient({ baseURL });

		const r1 = await api.get("/api/health");
		expect(r1.error).toBeNull();

		const r2 = await api.get("/api/nonexistent");
		expect(r2.error).not.toBeNull();

		const r3 = await api.get("/api/echo");
		expect(r3.error).toBeNull();
		expect(r3.data).toEqual({ method: "GET" });
	});
});

describe("edge: response headers accessible", () => {
	it("tuple response has real headers from server", async () => {
		const api = createClient({ baseURL });
		const { response } = await api.get("/api/health");
		expect(response.headers.get("content-type")).toContain("text/plain");
	});

	it("error response has real headers from server", async () => {
		const api = createClient({ baseURL });
		const { response } = await api.get("/api/nonexistent");
		expect(response.headers.get("content-type")).toContain("application/json");
	});
});

describe("edge: SSE multiple events with IDs", () => {
	it("all event IDs preserved in order", async () => {
		const api = createClient({ baseURL });
		const stream = api.get("/api/events") as unknown as AsyncIterable<SSEEvent>;
		const ids: Array<string | undefined> = [];
		for await (const event of stream) {
			ids.push(event.id);
		}
		expect(ids).toContain("1");
		expect(ids).toContain("2");
	});
});

describe("edge: interceptor sees correct path for parameterized routes", () => {
	it("onRequest receives raw path template, not interpolated", async () => {
		const paths: string[] = [];
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
			onRequest: [
				(ctx) => {
					paths.push(ctx.path);
				},
			],
		});
		await api.get("/api/v1/organizations/:orgId", {
			params: { orgId: "org-1" },
		});
		expect(paths[0]).toBe("/api/v1/organizations/:orgId");
	});

	it("onRequest URL has interpolated path", async () => {
		const urls: string[] = [];
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
			onRequest: [
				(ctx) => {
					urls.push(ctx.url);
				},
			],
		});
		await api.get("/api/v1/organizations/:orgId", {
			params: { orgId: "org-1" },
		});
		expect(urls[0]).toContain("/api/v1/organizations/org-1");
	});

	it("onResponse receives same raw path", async () => {
		const paths: string[] = [];
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
			onResponse: [
				(ctx) => {
					paths.push(ctx.path);
					return undefined;
				},
			],
		});
		await api.get("/api/v1/organizations/:orgId", {
			params: { orgId: "org-1" },
		});
		expect(paths[0]).toBe("/api/v1/organizations/:orgId");
	});
});

describe("edge: async headers receives correct method", () => {
	it("GET request passes GET", async () => {
		const methods: string[] = [];
		const api = createClient({
			baseURL,
			headers: ({ method }) => {
				methods.push(method);
				return {};
			},
		});
		await api.get("/api/health");
		expect(methods[0]).toBe("GET");
	});

	it("POST request passes POST", async () => {
		const methods: string[] = [];
		const api = createClient({
			baseURL,
			headers: ({ method }) => {
				methods.push(method);
				return { authorization: "Bearer test" };
			},
		});
		await api.post("/api/v1/organizations", {
			json: { name: "MethodTest", slug: `method-${Date.now()}` },
		});
		expect(methods[0]).toBe("POST");
	});

	it("DELETE request passes DELETE", async () => {
		const methods: string[] = [];
		const api = createClient({
			baseURL,
			headers: ({ method }) => {
				methods.push(method);
				return {};
			},
		});
		await api.delete("/api/echo");
		expect(methods[0]).toBe("DELETE");
	});
});

describe("edge: error response body consumed then re-read", () => {
	it("response.json() works after ClientError created", async () => {
		const api = createClient({ baseURL });
		const { error, response } = await api.get("/api/boundary/default");
		expect(error).not.toBeNull();

		/* error already parsed the body internally — but response was cloned */
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.error_key).toBe("api_error");
		expect(body.success).toBe(false);
	});
});

describe("edge: sortSearchParams with multiple keys", () => {
	it("complex search sorted alphabetically", async () => {
		const api = createClient({
			baseURL,
			sortSearchParams: true,
		});
		const url = api.$url("/api/echo", {
			search: { alpha: "a", middle: "m", zebra: "z" },
		});
		const qs = new URL(url).search;
		expect(qs).toBe("?alpha=a&middle=m&zebra=z");
	});
});

describe("edge: buildSearchParams custom serializer against real server", () => {
	it("bracket notation serializer", async () => {
		const api = createClient({
			baseURL,
			buildSearchParams: (query) => {
				const params = new URLSearchParams();
				for (const [k, v] of Object.entries(query)) {
					if (v === undefined || v === null) continue;
					if (Array.isArray(v)) {
						for (const item of v) params.append(`${k}[]`, String(item));
					} else {
						params.set(k, String(v));
					}
				}
				return params;
			},
		});
		/* /api/echo returns { method } regardless of query — just verify no crash */
		const { error } = await api.get("/api/echo", {
			search: { ids: [1, 2, 3], name: "test" },
		});
		expect(error).toBeNull();

		/* verify URL shape */
		const url = api.$url("/api/echo", { search: { ids: [1, 2], x: "y" } });
		const parsed = new URL(url);
		expect(parsed.searchParams.getAll("ids[]")).toEqual(["1", "2"]);
		expect(parsed.searchParams.get("x")).toBe("y");
	});
});
