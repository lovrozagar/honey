import { describe, expect, it } from "vitest"
import {
	camelWords,
	compareCodeUnits,
	goExported,
	goLocal,
	isRustPreludeType,
	NameScope,
	NameTable,
	pascalWords,
	pyClassName,
	pyIdentifier,
	rustPlainSnake,
	rustTypeIdent,
	rustValueIdent,
	snakeWords,
	sortedEntries,
	words,
} from "./lang.ts"

describe("lang: words and their order", () => {
	it("splits any identifier-ish text into words, and joins them PascalCase keeping inner case", () => {
		expect([words("user-id"), words("userId"), words("HTTPServer2Go"), words("__a__b"), words("")]).toEqual([
			["user", "id"],
			["user", "Id"],
			["HTTP", "Server2", "Go"],
			["a", "b"],
			[],
		])
		expect(["user-id", "getHTTP", "x.y_z", "/"].map(pascalWords)).toEqual(["UserId", "GetHTTP", "XYZ", ""])
	})

	it("orders by code unit: upper case before lower, never by locale", () => {
		expect(["b", "B", "a", "_", "é"].sort(compareCodeUnits)).toEqual(["B", "_", "a", "b", "é"])
		expect([compareCodeUnits("x", "x"), compareCodeUnits("a", "b"), compareCodeUnits("b", "a")]).toEqual([0, -1, 1])
	})
})

describe("lang: casings and order", () => {
	it("joins words snake_case and camelCase, and sorts entries by key in code-unit order", () => {
		expect(["user-id", "HTTPServer", "x"].map(snakeWords)).toEqual(["user_id", "http_server", "x"])
		expect(["user-id", "HTTPServer", "", "_a"].map(camelWords)).toEqual(["userId", "hTTPServer", "", "a"])
		expect(sortedEntries({ b: 1, B: 2, a: 3 })).toEqual([
			["B", 2],
			["a", 3],
			["b", 1],
		])
	})
})

describe("lang: names that never collide", () => {
	it("claims each name once, suffixing a taken one in claim order, under a case fold and reserved names", () => {
		const scope = new NameScope(["Client"], (name) => name.toLowerCase())
		expect([
			scope.claim("client"),
			scope.claim("user"),
			scope.claim("User"),
			scope.claim("user"),
			scope.has("USER"),
		]).toEqual(["client2", "user", "User2", "user3", true])
		scope.reserve("item")
		expect([scope.claim("Item"), new NameScope().claim("x")]).toEqual(["Item2", "x"])
	})

	it("gives one raw key the same name every time", () => {
		const table = new NameTable(["type"])
		expect([table.get("a-b", "type"), table.get("c", "type"), table.get("a-b", "other")]).toEqual([
			"type2",
			"type3",
			"type2",
		])
	})
})

describe("lang: identifiers per language", () => {
	it("Go: an exported name or a local one, never empty, a number first or a keyword", () => {
		expect(["user-id", "", "2fa", "_"].map(goExported)).toEqual(["UserId", "X", "N2fa", "X"])
		expect(["user-id", "", "2fa", "type", "string", "fmt", "map", "ok"].map(goLocal)).toEqual([
			"userId",
			"v",
			"n2fa",
			"type_",
			"string_",
			"fmt_",
			"map_",
			"ok",
		])
	})

	it("Rust: snake values (raw identifiers where allowed), plain snake for joining, and Pascal types", () => {
		expect(["user-id", "", "2fa", "type", "self", "crate", "gen", "Self"].map(rustValueIdent)).toEqual([
			"user_id",
			"value",
			"_2fa",
			"r#type",
			"self_",
			"crate_",
			"r#gen",
			"self_",
		])
		expect(["type", "", "9x"].map(rustPlainSnake)).toEqual(["type_", "value", "_9x"])
		expect(["user-id", "", "2fa", "self"].map(rustTypeIdent)).toEqual(["UserId", "Value", "N2fa", "Self_"])
		expect(["Option", "Vec", "User"].map(isRustPreludeType)).toEqual([true, true, false])
	})

	it("Python: snake identifiers and Pascal classes, keywords and reserved names suffixed", () => {
		expect(["user-id", "", "2fa", "class", "self", "match", "ok"].map(pyIdentifier)).toEqual([
			"user_id",
			"value",
			"_2fa",
			"class_",
			"self_",
			"match_",
			"ok",
		])
		expect(["user", "", "2fa", "none"].map(pyClassName)).toEqual(["User", "Model", "N2fa", "None_"])
	})
})
