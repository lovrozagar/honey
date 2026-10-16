/**
 * The emitted Python types, checked and run (contract 28 §7.3): the `types` registry package passes mypy --strict
 * and imports; consumer programs over it show what text alone cannot (an optional nullable key sends absent, null
 * and a value as three requests; keys no identifier spells keep their spelling); and mypy holds a TypedDict to its
 * required keys and its closed set of keys, while recursive, inherited, merged and union values type-check.
 */
import { describe, expect, it } from "vitest"
import { type Json, served } from "../shared/__fixtures__/recording-server.ts"
import { compiledPython } from "./__fixtures__/compiled.ts"
import { checked, consume } from "./__fixtures__/consumer.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()

/* a cold cache creates the venv and the mypy base cache */
const GATE = 300_000

/* the H43 keys: none an identifier spells, keywords among them */
const ITEM = { "2fa": true, "@type": "x", class: "c", "content-type": "t", from: "f" }

const THING = { attrs: {}, tags: [] }

/** A consumer program run against the recording server answering `replies`: whether it ran, its notes, each request's JSON body. */
async function wire(name: string, body: string, replies: readonly Json[]) {
	return served(
		replies.map((json) => ({ json, status: 200 })),
		async (server) => {
			const run = await consume("types", name, { base: server.url, body })
			return {
				bodies: server.hops.map((hop) => hop.body.json),
				notes: (run.out?.main ?? []).map((line) => JSON.parse(line) as unknown),
				ran: run.ran,
				stderr: run.stderr,
			}
		},
	)
}

describe.skipIf(!PY)("emitted Python TypedDicts on the wire: optional, nullable and unspellable keys", () => {
	// v0: 2e957a2bef
	it(
		"sends an absent optional nullable key, None and a value as three distinct requests",
		async () => {
			const body = [
				"c = client()",
				'c.things.create({"tags": [], "attrs": {}})',
				'c.things.create({"tags": [], "attrs": {}, "note": None})',
				'c.things.create({"tags": [], "attrs": {}, "note": "n"})',
				"c.close()",
			].join("\n")
			expect(await wire("tri-state", body, [THING, THING, THING])).toEqual({
				bodies: [THING, { ...THING, note: null }, { ...THING, note: "n" }],
				notes: [],
				ran: true,
				stderr: expect.any(String),
			})
		},
		GATE,
	)

	// v0: 300b713032
	it(
		"passes mypy --strict and imports with keys that are not identifiers, and keeps each key as spelled",
		async () => {
			const sdk = compiledPython("types")
			expect({ imported: sdk.imported, mypy: sdk.mypy(), stderr: sdk.stderr }).toEqual({
				imported: true,
				mypy: [],
				stderr: expect.any(String),
			})
			const body = 'c = client()\nnote(c.items.get("i1"))\nc.close()'
			expect(await wire("unspellable", body, [ITEM])).toEqual({
				bodies: [undefined],
				notes: [ITEM],
				ran: true,
				stderr: expect.any(String),
			})
		},
		GATE,
	)
})

describe.skipIf(!PY)(
	"emitted Python TypedDicts under mypy: tri-state, required keys, closed keys and recursive values",
	() => {
		// v0: 2e957a2bef
		it(
			"types absent, None and a value as valid for an optional nullable key, and rejects another type",
			() => {
				const program = [
					"from honey_sdk import Thing",
					"",
					'absent: Thing = {"tags": [], "attrs": {}}',
					'null: Thing = {"tags": [], "attrs": {}, "note": None}',
					'value: Thing = {"tags": [], "attrs": {}, "note": "n", "x-key": 3}',
					'wrong: Thing = {"tags": [], "attrs": {}, "note": 1}',
					"",
				].join("\n")
				expect(checked("types", program)).toEqual([expect.stringMatching(/:6: error: .*"note"/)])
			},
			GATE,
		)

		it(
			"rejects a value missing a required key: the TypedDict is total",
			() => {
				const program = "from honey_sdk import X\n\nx: X = {}\n"
				expect(checked("types", program)).toEqual([expect.stringContaining('Missing key "id" for TypedDict "X"')])
			},
			GATE,
		)

		it(
			"rejects a key a closed object does not declare",
			() => {
				const program = 'from honey_sdk import Closed\n\nc: Closed = {"id": "1", "x": 1}\n'
				expect(checked("types", program)).toEqual([expect.stringContaining('Extra key "x" for TypedDict "Closed"')])
			},
			GATE,
		)

		it(
			"type-checks recursive, mutually recursive, inherited, merged, empty, union and alias values",
			() => {
				const program = [
					"from honey_sdk import A, Comment, Empty, Ext, Merged, Pet, Role, Tags",
					"",
					'comment: Comment = {"parent": {"parent": {}}}',
					'a: A = {"b": {"a": {}}}',
					'ext: Ext = {"x": "s", "y": "t"}',
					'merged: Merged = {"a": "s", "b": 1}',
					"empty: Empty = {}",
					'dog: Pet = {"kind": "dog", "name": "rex"}',
					'cat: Pet = {"kind": "cat", "lives": 9}',
					'role: Role = "admin"',
					'tags: Tags = ["a"]',
					"",
				].join("\n")
				expect(checked("types", program)).toEqual([])
			},
			GATE,
		)
	},
)
