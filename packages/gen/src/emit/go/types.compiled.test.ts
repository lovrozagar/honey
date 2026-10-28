import { describe, expect, it } from "vitest"
import { goString } from "../shared/escape.ts"
import { compileGo } from "./__fixtures__/compiled.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

type Json = Record<string, unknown>

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const STRING = { type: "string" }
const object = (properties: Json, required: string[] = []) => ({ properties, required, type: "object" })

/* one component per mapping category the type tables cover; names stay clear of the runtime's */
const SCHEMAS: Record<string, Json> = {
	Ack: { const: false, type: "boolean" },
	Animal: { discriminator: { propertyName: "kind" }, oneOf: [ref("Dog"), ref("Cat")] },
	Attrs: { additionalProperties: STRING, type: "object" },
	Base: object({ id: STRING }, ["id"]),
	Cat: object({ kind: { enum: ["cat"], type: "string" } }, ["kind"]),
	Comment: object({ parent: ref("Comment") }),
	Definition: object({ filters: object({ limit: { type: "integer" }, search: STRING }, ["limit"]) }, ["filters"]),
	Dog: object({ kind: { const: "dog" }, name: STRING }, ["kind", "name"]),
	Ext: { allOf: [ref("Base"), object({ y: STRING })] },
	Feed: object({ items: { items: object({ id: STRING, score: { type: "number" } }, ["id"]), type: "array" } }, [
		"items",
	]),
	Level: { enum: [1, 2], type: "integer" },
	Names: { items: STRING, type: "array" },
	Odd: object({ "bad-key": STRING }),
	Registry: object(
		{ entries: { additionalProperties: object({ active: { type: "boolean" }, version: STRING }, ["version"]) } },
		["entries"],
	),
	Reserved: object({ chan: STRING, func: STRING, type: STRING }, ["type", "chan", "func"]),
	Role: { enum: ["a", "b"], type: "string" },
	Settings: { ...object({ id: STRING }, ["id"]), additionalProperties: STRING },
	Thing: object(
		{
			attrs: { additionalProperties: STRING, type: "object" },
			note: { type: ["string", "null"] },
			parent: { anyOf: [ref("Thing"), { type: "null" }] },
			plain: STRING,
			tags: { items: STRING, type: "array" },
			"x-key": { type: ["integer", "null"] },
		},
		["tags", "attrs"],
	),
}

const json = (schema: Json) => ({ content: { "application/json": { schema } } })

const DOCUMENT = {
	components: { schemas: SCHEMAS },
	info: { title: "Types", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/things": {
			post: {
				operationId: "things.create",
				requestBody: { ...json(ref("Thing")), required: true },
				responses: { 200: { ...json(ref("Thing")), description: "ok" } },
			},
		},
	},
}

/* encodes and decodes the emitted types and prints one JSON array of what it saw */
const CHECK = `package main

import (
	"encoding/json"
	"fmt"
	"os"

	sdk "example.com/typecheck"
)

func encode(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return err.Error()
	}
	return string(b)
}

func decode[T any](text string) T {
	var v T
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		panic(err)
	}
	return v
}

func main() {
	thing := decode[sdk.Thing](\`{"note":null,"parent":{"tags":[],"attrs":{}}}\`)
	parent, hasParent := thing.Parent.Get()
	settings := decode[sdk.Settings](\`{"id":"c1","region":"eu"}\`)
	dog := decode[sdk.Animal](\`{"kind":"dog","name":"rex"}\`)
	bird := decode[sdk.Animal](\`{"kind":"bird"}\`)
	value, y := "v", "y"
	out := []string{
		encode(sdk.Thing{}),
		encode(sdk.Thing{Note: sdk.NullOf[string](), XKey: sdk.Some[int64](3)}),
		fmt.Sprintf("%t %t %t", thing.Note.IsNull(), thing.XKey.IsZero(), hasParent && parent != nil),
		encode(settings),
		settings.Extra["region"],
		encode(dog),
		fmt.Sprintf("%t %t %s", dog.Dog != nil && dog.Dog.Name == "rex", dog.Cat == nil, bird.Raw),
		encode(sdk.Definition{Filters: sdk.DefinitionFilters{Limit: 5}}),
		encode(sdk.Feed{}),
		encode(sdk.Feed{Items: []sdk.FeedItemsItem{{Id: "a"}}}),
		encode(sdk.Registry{Entries: map[string]sdk.RegistryEntries{"x": {Version: "1"}}}),
		encode(sdk.Odd{BadKey: &value}),
		encode(sdk.Reserved{Type: "t", Chan: "c", Func: "f"}),
		fmt.Sprintf("%s %d %t", sdk.RoleA, sdk.Level2, sdk.AckValue),
		encode(sdk.Ext{Base: sdk.Base{Id: "b"}, Y: &y}),
		encode(sdk.Comment{Parent: &sdk.Comment{}}),
		encode(sdk.Names{"x"}),
		encode(sdk.Attrs{"k": "v"}),
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		os.Exit(1)
	}
}
`

goDescribe("the emitted Go types compile and run", () => {
	// v0: 63c75b0973
	it("builds and vets, keeps absent, null and a value apart, and encodes required lists and maps as []/{}", () => {
		const sdk = compileGo(generateGoSdk(DOCUMENT, { modulePath: "example.com/typecheck" }).files, { main: CHECK })
		expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
		const ran = sdk.run()
		expect(ran.status, ran.stderr).toBe(0)
		expect(JSON.parse(ran.stdout)).toEqual([
			'{"attrs":{},"tags":[]}',
			'{"attrs":{},"note":null,"tags":[],"x-key":3}',
			"true true true",
			'{"id":"c1","region":"eu"}',
			"eu",
			'{"kind":"dog","name":"rex"}',
			'true true {"kind":"bird"}',
			'{"filters":{"limit":5}}',
			'{"items":[]}',
			'{"items":[{"id":"a"}]}',
			'{"entries":{"x":{"version":"1"}}}',
			'{"bad-key":"v"}',
			'{"chan":"c","func":"f","type":"t"}',
			"a 2 false",
			'{"id":"b","y":"y"}',
			'{"parent":{}}',
			'["x"]',
			'{"k":"v"}',
		])
	}, 600_000)
})

const PAIR = { "a`b": "1", 'q"k': "2" }
const WRAPPED = { 'q"k': "q", y: "y" }
const COMBINED = { "a`b": "a", 'q"k': "q", y: "y" }
const DASH = { "-": "d" }
const KEYED = object({ 'q"k': STRING }, ['q"k'])

/* keys encoding/json cannot tag, the key "-", and allOf over a part that (un)marshals itself */
const KEYS_DOCUMENT = {
	...DOCUMENT,
	paths: {},
	components: {
		schemas: {
			Combined: { allOf: [ref("Keyed"), object({ "a`b": STRING, y: STRING }, ["a`b"])] },
			Dash: object({ "-": STRING }, ["-"]),
			Keyed: KEYED,
			MaybeDash: object({ "-": STRING }),
			Pair: object({ "a`b": STRING, 'q"k': STRING }, ["a`b", 'q"k']),
			Wrapped: { allOf: [ref("Keyed"), object({ y: STRING })] },
		},
	},
}

/** A Go string literal of `value` as JSON. */
const wire = (value: unknown) => goString(JSON.stringify(value))

/* encodes each value and decodes-then-encodes its wire text; prints one JSON object of what it saw */
const KEYS_CHECK = `package main

import (
	"encoding/json"
	"os"

	sdk "example.com/typekeys"
)

func encode(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return err.Error()
	}
	return string(b)
}

func back[T any](text string) string {
	var v T
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		return err.Error()
	}
	return encode(v)
}

func main() {
	q, y, d := "q", "y", "d"
	out := map[string]string{
		"pair":          encode(sdk.Pair{AB: "1", QK: "2"}),
		"pairBack":      back[sdk.Pair](${wire(PAIR)}),
		"dash":          encode(sdk.Dash{X: d}),
		"dashBack":      back[sdk.Dash](${wire(DASH)}),
		"maybeDash":     encode(sdk.MaybeDash{X: &d}),
		"maybeDashBack": back[sdk.MaybeDash](${wire(DASH)}),
		"wrapped":       encode(sdk.Wrapped{Keyed: sdk.Keyed{QK: q}, Y: &y}),
		"wrappedBack":   back[sdk.Wrapped](${wire(WRAPPED)}),
		"combined":      encode(sdk.Combined{Keyed: sdk.Keyed{QK: q}, AB: "a", Y: &y}),
		"combinedBack":  back[sdk.Combined](${wire(COMBINED)}),
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		os.Exit(1)
	}
}
`

type Seen = { built: boolean; stderr: string; vet: readonly string[]; out?: Record<string, unknown> }

let keys: Seen | undefined
/** KEYS_DOCUMENT's SDK built and vetted once with KEYS_CHECK, and what KEYS_CHECK printed (JSON values parsed). */
function keysSdk(): Seen {
	if (keys) return keys
	const sdk = compileGo(generateGoSdk(KEYS_DOCUMENT, { modulePath: "example.com/typekeys" }).files, {
		main: KEYS_CHECK,
	})
	const ran = sdk.built ? sdk.run() : undefined
	const printed = ran?.status === 0 ? (JSON.parse(ran.stdout) as Record<string, string>) : undefined
	keys = { built: sdk.built, stderr: sdk.stderr + (ran?.stderr ?? ""), vet: sdk.vet }
	if (printed) keys.out = Object.fromEntries(Object.entries(printed).map(([name, text]) => [name, JSON.parse(text)]))
	return keys
}

/** The built, vet and printed values `names` of the keys SDK. */
function seenOf(...names: string[]) {
	const seen = keysSdk()
	return { built: seen.built, out: names.map((name) => seen.out?.[name]), vet: seen.vet }
}

goDescribe(
	"emitted Go types on the wire: keys encoding/json cannot tag, and allOf parts that encode themselves",
	() => {
		it("compiles two required untagged keys and round-trips them", () => {
			expect(seenOf("pair", "pairBack"), keysSdk().stderr).toEqual({ built: true, out: [PAIR, PAIR], vet: [] })
		}, 600_000)

		/* V0BUG: v0 tagged the key "-" as json:"-", which encoding/json skips; the fix is json:"-," */
		it("sends and reads the key -, required and optional", () => {
			const out = [DASH, DASH, DASH, DASH]
			expect(seenOf("dash", "dashBack", "maybeDash", "maybeDashBack"), keysSdk().stderr).toEqual({
				built: true,
				out,
				vet: [],
			})
		}, 600_000)

		/* V0BUG: v0 embedded the part, so its promoted methods dropped the allOf's own fields (ruling 2) */
		it("keeps an allOf's own fields beside a part with its own (un)marshal methods, encoded and decoded", () => {
			const out = [WRAPPED, WRAPPED]
			expect(seenOf("wrapped", "wrappedBack"), keysSdk().stderr).toEqual({ built: true, out, vet: [] })
		}, 600_000)

		it("round-trips an allOf with such a part and a backtick key of its own exactly", () => {
			const out = [COMBINED, COMBINED]
			expect(seenOf("combined", "combinedBack"), keysSdk().stderr).toEqual({ built: true, out, vet: [] })
		}, 600_000)
	},
)

/* a JSON body with no schema: its parameter is a json.RawMessage, so client.go imports encoding/json (found by bit 17's CLI) */
const RAW_BODY_DOCUMENT = {
	info: { title: "Raw", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/raw": {
			post: {
				operationId: "raw.send",
				requestBody: { content: { "application/json": { schema: {} } }, required: true },
				responses: { 204: { description: "done" } },
			},
		},
	},
}

goDescribe("a JSON body with no schema", () => {
	it(
		"compiles: the method takes a json.RawMessage, and client.go imports encoding/json",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const sdk = compileGo(generateGoSdk(RAW_BODY_DOCUMENT, { modulePath: "example.com/rawbody" }).files)
			expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
		},
	)
})
