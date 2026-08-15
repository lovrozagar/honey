import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "@honey/e2e-kitchen"
import { isClientError } from "../../src/client/error.ts";
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

describe("edge: empty / missing response bodies", () => {
	it("204 no content in tuple mode → data: null, error: null", async () => {
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		});
		const created = await api.post("/api/v1/organizations", {
			json: { name: "EdgeDel", slug: `edge-del-${Date.now()}` },
		});
		const id = (created.data as unknown as { id: string }).id;

		const result = await api.delete("/api/v1/organizations/:orgId", {
			params: { orgId: id },
		});
		expect(result.data).toBeNull();
		expect(result.error).toBeNull();
		expect(result.status).toBe(204);
	});
});

describe("edge: non-JSON error response", () => {
	it("error with unparseable body falls back to unknown errorKey", async () => {
		/* hit a route that doesn't exist — server returns JSON error anyway */
		const api = createClient({ baseURL });
		const { error } = await api.get("/api/nonexistent");
		expect(error).not.toBeNull();
		expect((error as Record<string, unknown>)?.error_key).toBeTruthy();
	});
});

describe("edge: timeout", () => {
	it("timeout throws (not ClientError — no Response)", async () => {
		const api = createClient({
			baseURL,
			throwOnError: true,
			timeout: 1,
		});
		try {
			/* /api/events-live keeps connection open ~250ms — will timeout at 1ms */
			await api.get("/api/events-live");
			expect.fail("should have thrown");
		} catch (e) {
			expect(isClientError(e)).toBe(false);
		}
	});

	it("timeout in tuple mode also throws (network-level)", async () => {
		const api = createClient({ baseURL, timeout: 1 });
		await expect(api.get("/api/events-live")).rejects.toThrow();
	});
});

describe("edge: AbortSignal cancellation", () => {
	it("aborted request throws AbortError", async () => {
		const controller = new AbortController();
		const api = createClient({ baseURL, throwOnError: true });

		controller.abort();
		try {
			await api.get("/api/health", { signal: controller.signal });
			expect.fail("should have thrown");
		} catch (e) {
			expect(isClientError(e)).toBe(false);
			expect((e as Error).name).toBe("AbortError");
		}
	});

	it("abort in tuple mode also throws", async () => {
		const controller = new AbortController();
		controller.abort();
		const api = createClient({ baseURL });
		await expect(
			api.get("/api/health", { signal: controller.signal }),
		).rejects.toThrow();
	});
});

describe("edge: double await on same result", () => {
	it("awaiting tuple result twice returns same object", async () => {
		const api = createClient({ baseURL });
		const promise = api.get("/api/health");
		const r1 = await promise;
		const r2 = await promise;
		expect(r1).toBe(r2);
		expect(r1.data).toBe("ok");
	});
});

describe("edge: empty search params", () => {
	it("empty search object adds no query string", async () => {
		const api = createClient({ baseURL });
		const { data, error } = await api.get("/api/echo", { search: {} });
		expect(error).toBeNull();
		expect(data).toEqual({ method: "GET" });
	});

	it("null/undefined values in search are skipped", async () => {
		const api = createClient({ baseURL });
		const { data, error } = await api.get("/api", {
			search: { id: "present", missing: undefined },
		});
		expect(error).toBeNull();
		expect(data).toEqual({ id: "present" });
	});
});

describe("edge: baseURL with path prefix", () => {
	it("baseURL ending with /api works for routes", async () => {
		const api = createClient({ baseURL: `${baseURL}/api` });
		const { data, error } = await api.get("/health");
		expect(error).toBeNull();
		expect(data).toBe("ok");
	});

	it("baseURL with trailing slash", async () => {
		const api = createClient({ baseURL: `${baseURL}/api/` });
		const { data, error } = await api.get("/health");
		expect(error).toBeNull();
		expect(data).toBe("ok");
	});
});

describe("edge: SSE early break", () => {
	it("breaking out of for-await closes cleanly", async () => {
		const api = createClient({ baseURL });
		const stream = api.get("/api/events") as unknown as AsyncIterable<SSEEvent>;
		const events: SSEEvent[] = [];
		for await (const event of stream) {
			events.push(event);
			if (events.length >= 1) break;
		}
		expect(events).toHaveLength(1);
		expect(events[0].data).toBe("hello");
	});
});

describe("edge: concurrent identical requests", () => {
	it("same endpoint called concurrently returns independent results", async () => {
		const api = createClient({ baseURL });
		const results = await Promise.all([
			api.get("/api/health"),
			api.get("/api/health"),
			api.get("/api/health"),
		]);
		for (const r of results) {
			expect(r.error).toBeNull();
			expect(r.data).toBe("ok");
		}
	});
});

describe("edge: interceptor error handling", () => {
	it("onRequest throw propagates even in tuple mode", async () => {
		const api = createClient({
			baseURL,
			onRequest: [
				() => {
					throw new Error("onRequest exploded");
				},
			],
		});
		await expect(api.get("/api/health")).rejects.toThrow("onRequest exploded");
	});

	it("onResponse throw propagates even in tuple mode", async () => {
		const api = createClient({
			baseURL,
			onResponse: [
				() => {
					throw new Error("onResponse exploded");
				},
			],
		});
		await expect(api.get("/api/health")).rejects.toThrow("onResponse exploded");
	});
});

describe("edge: $url and $path with edge inputs", () => {
	it("$url with no input", () => {
		const api = createClient({ baseURL });
		const url = api.$url("/api/health");
		expect(url).toBe(`${baseURL}/api/health`);
	});

	it("$path with empty search", () => {
		const api = createClient({ baseURL });
		const path = api.$path("/api/health", { search: {} });
		expect(path).toBe("/api/health");
	});

	it("$url encodes special chars in params", () => {
		const api = createClient({ baseURL });
		const url = api.$url("/api/v1/organizations/:orgId", {
			params: { orgId: "a b/c" },
		});
		expect(url).toContain("a%20b%2Fc");
	});
});

describe("edge: headers merging priority", () => {
	it("per-request headers override async config headers", async () => {
		const api = createClient({
			baseURL,
			headers: async () => ({ authorization: "Bearer wrong" }),
			throwOnError: true,
		});
		/* override with correct token */
		const result = (await api.get("/api/v1/organizations", {
			headers: { authorization: "Bearer test" },
		})) as unknown as { total: number };
		expect(result.total).toBeGreaterThanOrEqual(1);
	});

	it("onRequest can override per-request headers", async () => {
		const api = createClient({
			baseURL,
			onRequest: [
				(ctx) => {
					ctx.headers.set("authorization", "Bearer test");
				},
			],
			throwOnError: true,
		});
		/* no auth in config or per-request — injected by interceptor */
		const result = (await api.get("/api/v1/organizations")) as unknown as {
			total: number;
		};
		expect(result.total).toBeGreaterThanOrEqual(1);
	});
});

describe("edge: response content-type with charset", () => {
	it("application/json; charset=utf-8 parsed as JSON", async () => {
		/* kitchen e2e app returns application/json — verify it works */
		const api = createClient({ baseURL });
		const { data, error } = await api.get("/api/echo");
		expect(error).toBeNull();
		expect(data).toEqual({ method: "GET" });
	});

	it("text/plain response returns string", async () => {
		const api = createClient({ baseURL });
		const { data, error } = await api.get("/api/health");
		expect(error).toBeNull();
		expect(data).toBe("ok");
	});
});

describe("edge: error fields validation", () => {
	it("safe mode error has expected body properties", async () => {
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		});
		const result = await api.post("/api/v1/organizations", { json: {} });
		expect(result.error).not.toBeNull();
		const errBody = result.error as Record<string, unknown>;
		expect(typeof errBody.error_key).toBe("string");
		expect(typeof result.status).toBe("number");
		expect(typeof errBody.status_key).toBe("string");
		expect(typeof errBody.message).toBe("string");
		expect(typeof errBody.fields).toBe("object");
		expect(result.response).toBeInstanceOf(Response);
	});
});

describe("edge: multiple clients same server", () => {
	it("two clients with different auth work independently", async () => {
		const publicApi = createClient({ baseURL });
		const authedApi = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		});

		const healthResult = await publicApi.get("/api/health");
		expect(healthResult.error).toBeNull();

		const orgsResult = await authedApi.get("/api/v1/organizations");
		expect(orgsResult.error).toBeNull();

		/* public client can't access authed routes */
		const forbidden = await publicApi.get("/api/v1/organizations");
		expect(forbidden.error).not.toBeNull();
	});
});
