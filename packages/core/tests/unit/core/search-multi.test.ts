import { describe, expect, it } from "vitest";
import { HoneyContext } from "../../../src/context.ts";

function makeCtx(url: string): HoneyContext {
	return new HoneyContext({
		env: {},
		params: {},
		req: new Request(url),
	});
}

describe("ctx.search — first value only", () => {
	it("single param → string", () => {
		const ctx = makeCtx("http://localhost/test?name=foo");
		expect(ctx.search.name).toBe("foo");
	});

	it("duplicate params → first value only", () => {
		const ctx = makeCtx("http://localhost/test?tags=a&tags=b&tags=c");
		expect(ctx.search.tags).toBe("a");
	});

	it("mixed single and multi → all strings", () => {
		const ctx = makeCtx("http://localhost/test?name=foo&tags=a&tags=b");
		expect(ctx.search.name).toBe("foo");
		expect(ctx.search.tags).toBe("a");
	});

	it("empty query → empty object", () => {
		const ctx = makeCtx("http://localhost/test");
		expect(ctx.search).toEqual({});
	});
});

describe("ctx.searchAll — always string[]", () => {
	it("single param → [string]", () => {
		const ctx = makeCtx("http://localhost/test?name=foo");
		expect(ctx.searchAll.name).toEqual(["foo"]);
	});

	it("multiple params → all values", () => {
		const ctx = makeCtx("http://localhost/test?tags=a&tags=b&tags=c");
		expect(ctx.searchAll.tags).toEqual(["a", "b", "c"]);
	});

	it("mixed → each key is string[]", () => {
		const ctx = makeCtx("http://localhost/test?name=foo&tags=a&tags=b");
		expect(ctx.searchAll.name).toEqual(["foo"]);
		expect(ctx.searchAll.tags).toEqual(["a", "b"]);
	});

	it("empty query → empty object", () => {
		const ctx = makeCtx("http://localhost/test");
		expect(ctx.searchAll).toEqual({});
	});
});

describe("search laziness and caching", () => {
	it("both lazy — null until accessed", () => {
		const ctx = makeCtx("http://localhost/test?x=1");
		expect(ctx._lzSearch).toBeNull();
		expect(ctx._lzSearchAll).toBeNull();
	});

	it("search cached on repeat access", () => {
		const ctx = makeCtx("http://localhost/test?x=1");
		const a = ctx.search;
		const b = ctx.search;
		expect(a).toBe(b);
	});

	it("searchAll cached on repeat access", () => {
		const ctx = makeCtx("http://localhost/test?x=1");
		const a = ctx.searchAll;
		const b = ctx.searchAll;
		expect(a).toBe(b);
	});

	it("no double URL parse — search and searchAll share parse", () => {
		let parseCount = 0;
		const ctx = new HoneyContext({
			env: {},
			params: {},
			req: new Request("http://localhost/test?x=1"),
			urlFn: () => {
				parseCount++;
				return new URL("http://localhost/test?x=1");
			},
		});
		void ctx.search;
		void ctx.searchAll;
		expect(parseCount).toBe(1);
	});
});
