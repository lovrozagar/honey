import { describe, expect, it } from "vitest"
import { compileGo } from "../go/__fixtures__/compiled.ts"
import { withGo } from "../go/__fixtures__/go-env.ts"
import {
	blockCommentText,
	commentText,
	goString,
	lineComment,
	pyDocLines,
	pyString,
	rustString,
	stringLiteral,
	tsString,
	wellFormed,
} from "./escape.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()

const LONE_HIGH = "\uD800"
const LONE_LOW = "\uDC00"
const PAIR = "\u{1F600}"

describe("wellFormed: text every target can encode", () => {
	it("replaces each unpaired surrogate with U+FFFD and keeps pairs", () => {
		expect([
			wellFormed(`a${LONE_HIGH}b`),
			wellFormed(`${LONE_LOW}x`),
			wellFormed(`${LONE_LOW}${LONE_HIGH}`),
			wellFormed(PAIR),
			wellFormed(`${LONE_HIGH}${PAIR}`),
		]).toEqual(["a\uFFFDb", "\uFFFDx", "\uFFFD\uFFFD", PAIR, `\uFFFD${PAIR}`])
	})
})

describe("string literals: one escaper, one policy per target", () => {
	const nasty = `q"b\\n\nr\rt\tz\0d\u007f e\u0001 ${LONE_HIGH} \u2028\u2029\u0085\uFEFF ${PAIR}`

	it("TypeScript: JSON-style escapes, U+2028, U+2029 and the BOM visible", () => {
		expect(tsString(nasty)).toBe(
			'"q\\"b\\\\n\\nr\\rt\\tz\\u0000d\u007f e\\u0001 \uFFFD \\u2028\\u2029\u0085\\ufeff \u{1F600}"',
		)
	})

	// v0: 11147399aa
	it("Go: named escapes, \\xHH for control bytes, the BOM as \\ufeff", () => {
		expect(goString(nasty)).toBe(
			'"q\\"b\\\\n\\nr\\rt\\tz\\x00d\\x7f e\\x01 \uFFFD \u2028\u2029\u0085\\ufeff \u{1F600}"',
		)
	})

	// v0: 658babeb20
	it("Rust: named escapes and \\0, \\u{H} for other control code points and the BOM", () => {
		expect(rustString(nasty)).toBe(
			'"q\\"b\\\\n\\nr\\rt\\tz\\0d\\u{7f} e\\u{01} \uFFFD \u2028\u2029\u0085\\u{feff} \u{1F600}"',
		)
		expect(rustString("\b\f\u0001")).toBe('"\\u{08}\\u{0c}\\u{01}"')
	})

	it("Python: \\xHH for control bytes, and line separators, NEL and the BOM as \\uHHHH", () => {
		expect(pyString(nasty)).toBe(
			'"q\\"b\\\\n\\nr\\rt\\tz\\x00d\\x7f e\\x01 \uFFFD \\u2028\\u2029\\u0085\\ufeff \u{1F600}"',
		)
	})

	it("routes every target through the one writer", () => {
		expect((["go", "python", "rust", "ts"] as const).map((target) => stringLiteral("a\nb", target))).toEqual([
			'"a\\nb"',
			'"a\\nb"',
			'"a\\nb"',
			'"a\\nb"',
		])
	})
})

describe("comments: text that can never become code", () => {
	it("shows control characters, DEL and the BOM as visible \\uXXXX, keeping tab and line breaks", () => {
		expect(commentText(`a\u0000b\u007fc\uFEFFd\te\nf${LONE_LOW}`)).toBe("a\\u0000b\\u007fc\\ufeffd\te\nf\uFFFD")
	})

	it("starts a new comment line at every line break, blank lines bare", () => {
		expect([
			lineComment("one\r\ntwo\u2028three\n\nfour", "//"),
			lineComment("doc", "///", "\t"),
			lineComment("  ", "#", "  "),
		]).toEqual([["// one", "// two", "// three", "//", "// four"], ["\t/// doc"], ["  #"]])
	})

	it("keeps a block comment closed and a docstring inert", () => {
		expect(blockCommentText("end */ start /* x")).toBe("end * / start / * x")
		expect(pyDocLines('say """hi""" at C:\\users\nnext"')).toEqual([
			'say \\"\\"\\"hi\\"\\"\\" at C:\\\\users',
			'next\\"',
		])
	})
})

/* a struct whose JSON keys a Go struct tag cannot hold raw: a backtick, a quote, a backslash */
const ODD_KEYS = { "a`b": "1", "back\\slash": "2", 'q"k': "3" }

/** Each json tag name of the emitted Odd (sorted), and the JSON of ODD_KEYS decoded into it and encoded again. */
const TAGS = `package main

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"strings"

	sdk "example.com/tags"
)

func main() {
	t := reflect.TypeFor[sdk.Odd]()
	var tags []string
	for i := range t.NumField() {
		tags = append(tags, strings.Split(t.Field(i).Tag.Get("json"), ",")[0])
	}
	slices.Sort(tags)
	var odd sdk.Odd
	if err := json.Unmarshal([]byte(${goString(JSON.stringify(ODD_KEYS))}), &odd); err != nil {
		panic(err)
	}
	wire, err := json.Marshal(odd)
	if err != nil {
		panic(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"tags": tags, "wire": string(wire)}); err != nil {
		os.Exit(1)
	}
}
`

/** The Odd struct emitted, built with TAGS beside it, and what TAGS saw. */
async function compileOdd() {
	const { generateGoSdk } = await import("../go/sdk.ts")
	const properties = Object.fromEntries(Object.keys(ODD_KEYS).map((key) => [key, { type: "string" }]))
	const schema = { properties, required: Object.keys(ODD_KEYS), type: "object" }
	const document = {
		components: { schemas: { Odd: schema } },
		info: { title: "Tags", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/odd": {
				get: {
					operationId: "odd.get",
					responses: {
						200: {
							content: { "application/json": { schema: { $ref: "#/components/schemas/Odd" } } },
							description: "ok",
						},
					},
				},
			},
		},
	}
	const sdk = compileGo(generateGoSdk(document, { modulePath: "example.com/tags" }).files, { main: TAGS })
	const ran = sdk.built ? sdk.run() : undefined
	const seen = ran?.status === 0 ? (JSON.parse(ran.stdout) as { tags: string[]; wire: string }) : undefined
	return { built: sdk.built, seen, stderr: sdk.stderr + (ran?.stderr ?? ""), vet: sdk.vet }
}

let odd: ReturnType<typeof compileOdd> | undefined
/** compileOdd, once. */
const oddStruct = () => (odd ??= compileOdd())

describe.skipIf(!GO)("Go struct tags: any JSON key", () => {
	it("gives a key holding a backtick, a quote or a backslash one json tag that reads back as the key, vet clean", async () => {
		const seen = await oddStruct()
		expect({ built: seen.built, tags: seen.seen?.tags, vet: seen.vet }, seen.stderr).toEqual({
			built: true,
			tags: Object.keys(ODD_KEYS).sort(),
			vet: [],
		})
	}, 600_000)

	it("sends and reads such a key as itself on the wire", async () => {
		const seen = await oddStruct()
		expect(JSON.parse(seen.seen?.wire ?? "null"), seen.stderr).toEqual(ODD_KEYS)
	}, 600_000)
})
