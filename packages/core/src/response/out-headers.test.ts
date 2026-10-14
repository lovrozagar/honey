import { afterEach, describe, expect, it, vi } from "vitest"
import { headersToRecord, HoneyOutHeaders } from "./out-headers.ts"

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("HoneyOutHeaders reads the plain map", () => {
	// v0: 8390d48c77
	it("HoneyOutHeaders only reads own keys", () => {
		const headers = new HoneyOutHeaders({ "content-type": "text/plain" })
		expect(headers.get("constructor")).toBeNull()
		expect(headers.has("toString")).toBe(false)
		expect(headers.get("content-type")).toBe("text/plain")
	})

	it("get and has are case-insensitive; a list joins with a comma", () => {
		const headers = new HoneyOutHeaders({ vary: ["origin", "accept"], "x-a": "1" })
		expect(headers.get("X-A")).toBe("1")
		expect(headers.has("X-A")).toBe(true)
		expect(headers.get("vary")).toBe("origin, accept")
		expect(headers.get("missing")).toBeNull()
		expect(headers.has("missing")).toBe(false)
	})

	it("an undefined entry reads as absent", () => {
		const headers = new HoneyOutHeaders({ "x-gone": undefined as unknown as string })
		expect(headers.get("x-gone")).toBeNull()
		expect(headers.has("x-gone")).toBe(false)
		expect([...headers]).toEqual([])
	})

	it("getSetCookie returns each cookie, a single one as a list", () => {
		expect(new HoneyOutHeaders({ "set-cookie": ["a=1", "b=2"] }).getSetCookie()).toEqual(["a=1", "b=2"])
		expect(new HoneyOutHeaders({ "set-cookie": "a=1" }).getSetCookie()).toEqual(["a=1"])
		expect(new HoneyOutHeaders({}).getSetCookie()).toEqual([])
	})

	it("iterates the map without building native Headers, one entry per cookie", () => {
		const map = { "set-cookie": ["a=1", "b=2"], "x-a": "1" }
		const headers = new HoneyOutHeaders(map)
		expect([...headers]).toEqual([
			["set-cookie", "a=1"],
			["set-cookie", "b=2"],
			["x-a", "1"],
		])
		expect(headers.toRecord()).toBe(map)
		expect(Object.prototype.toString.call(headers)).toBe("[object Headers]")
	})
})

describe("HoneyOutHeaders writes the plain map (the middleware path)", () => {
	it("set and delete write the map: no native Headers is built, the source map is never touched", () => {
		const source = { "content-type": "application/json", vary: "Origin" }
		const headers = new HoneyOutHeaders(source)
		vi.stubGlobal("Headers", function NativeHeaders() {
			throw new Error("native Headers built")
		})
		headers.set("X-Request-Id", "  r-1\t")
		headers.set("vary", "Origin, Accept-Encoding")
		headers.delete("content-type")
		headers.delete("x-never-set")
		expect([headers.toRecord(), source, headers.get("x-request-id")]).toEqual([
			{ vary: "Origin, Accept-Encoding", "x-request-id": "r-1" },
			{ "content-type": "application/json", vary: "Origin" },
			"r-1",
		])
	})

	it.each([
		["a name that is not a token", "bad name", "x"],
		["a value carrying CR/LF", "x-a", "1\r\nx-injected: 2"],
		["a value carrying NUL", "x-a", "1\u00002"],
	])("refuses %s exactly as native Headers does", (_name, name, value) => {
		const plain = new HoneyOutHeaders({})
		expect(() => plain.set(name, value)).toThrow(TypeError)
		expect(() => new Headers().set(name, value)).toThrow(TypeError)
	})

	it("after a native write, set and delete keep writing native", () => {
		const headers = new HoneyOutHeaders({ "x-a": "1" })
		headers.append("x-a", "2")
		headers.set("x-b", "3")
		headers.delete("x-a")
		expect(headers.toRecord()).toEqual({ "x-b": "3" })
	})
})

describe("HoneyOutHeaders upgrades to native Headers on append and the native walks", () => {
	it("append switches to native Headers and keeps cookies apart", () => {
		const headers = new HoneyOutHeaders({ "set-cookie": ["a=1", "b=2"], "x-a": "1" })
		headers.set("x-b", "2")
		headers.append("x-a", "3")
		headers.delete("x-gone")
		expect(headers.get("x-a")).toBe("1, 3")
		expect(headers.has("x-b")).toBe(true)
		expect(headers.getSetCookie()).toEqual(["a=1", "b=2"])
		expect(headers.toRecord()).toEqual({ "set-cookie": ["a=1", "b=2"], "x-a": "1, 3", "x-b": "2" })
		expect([...headers]).toContainEqual(["x-b", "2"])
	})

	it("forEach, keys, values and entries read through native Headers", () => {
		const headers = new HoneyOutHeaders({ "x-a": "1", "x-b": "2" })
		const seen: string[] = []
		headers.forEach((value, key) => seen.push(`${key}=${value}`))
		expect(seen).toEqual(["x-a=1", "x-b=2"])
		expect([...headers.keys()]).toEqual(["x-a", "x-b"])
		expect([...headers.values()]).toEqual(["1", "2"])
		expect([...headers.entries()]).toEqual([
			["x-a", "1"],
			["x-b", "2"],
		])
	})
})

describe("headersToRecord", () => {
	it("copies native Headers and keeps each Set-Cookie as its own entry", () => {
		const headers = new Headers({ "x-a": "1" })
		headers.append("set-cookie", "a=1")
		headers.append("set-cookie", "b=2")
		expect(headersToRecord(headers)).toEqual({ "set-cookie": ["a=1", "b=2"], "x-a": "1" })
		expect(headersToRecord(new Headers({ "x-a": "1" }))).toEqual({ "x-a": "1" })
	})
})
