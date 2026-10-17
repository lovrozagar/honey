/**
 * Python's hostile names for the shared adversarial corpus (bit 14), merged by `adversarialCorpus()` so every
 * emitter still compiles one document: the emitted method's locals, Python's hard and soft keywords, the builtins
 * an annotation spells, `builtins` itself and dunders, as path params; keyword, dunder and soft-keyword
 * TypedDict keys; the names ruff calls ambiguous (`I`, `O`, `l`); a class-form TypedDict whose keys shadow the
 * builtins its annotations spell; methods named like builtins, `builtins` first; error keys that collide once
 * upper-cased; and the escape spellings a Python literal writer must not pass through (`\N{…}`, `\x41`, a
 * docstring closer, a non-hex `\u`, a trailing backslash). Made on use: a module under `src` runs no code as it
 * loads. Its own helpers, so the corpus imports it and nothing imports back.
 */

const S = { type: "string" }
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const ok = (schema: unknown) => ({ 200: { ...json(schema), description: "ok" } })
const path = (...names: string[]) => names.map((name) => ({ in: "path", name, required: true, schema: S }))
const query = (name: string, schema: unknown = S) => ({ in: "query", name, schema })
const status = (code: number | null) => ({ status: code })

/* the method's own names and Python's hard and soft keywords, builtins, `builtins` itself and dunders, as path params */
export const PY_LOCALS =
	"options idempotency_key headers_into cls def class from import lambda pass global nonlocal yield return is not and or in raise with as assert del elif else except finally for if while None True False break continue case type _ id list str int bytes dict float bool tuple object builtins __init__ __class__"

/* TypedDict keys: hard keywords, dunders, `_` and a soft keyword (User takes them; User is functional-form already) */
export const PY_KEYS = ["class", "from", "None", "_", "__total__", "__class__", "case", "async"]

/* a literal writer's Python spellings: a named escape, a hex escape, a docstring closer, a lone backslash */
export const PY_STATUS = ["\\N{DIGIT ONE}", "\\x41", '"""', "\\"]

/** `I` holds the names ruff's E741/E742 flag; `Shadowing` is a class-form TypedDict shadowing every builtin it spells. */
export function pythonSchemas() {
	return {
		I: { properties: { I: S, O: S, l: S }, type: "object" },
		Shadowing: {
			description: "vt\u000Bff\u000Cfs\u001Cnel\u0085end \\N{DIGIT ONE} ends with a backslash \\",
			properties: {
				bool: { type: "boolean" },
				builtins: S,
				bytes: S,
				case: S,
				dict: { additionalProperties: S, type: "object" },
				float: { type: "number" },
				int: { type: "integer" },
				list: { items: S, type: "array" },
				match: S,
				next: ref("Shadowing"),
				object: S,
				str: S,
				tuple: { items: { type: "integer" }, type: "array" },
				type: S,
				_: S,
				zz: S,
				zz_int: { type: "integer" },
				zz_list: { items: S, type: "array" },
			},
			required: ["str", "zz"],
			type: "object",
		},
	}
}

/** A POST taking `Shadowing`, typed queries, a summary ending in a backslash and error keys that collide upper-cased. */
function zzOp() {
	return {
		post: {
			operationId: "py.zz",
			parameters: [
				...path("id"),
				query("n", { type: "integer" }),
				query("flag", { type: "boolean" }),
				query("x", { type: "number" }),
				query("q"),
			],
			requestBody: { ...json(ref("Shadowing")), required: true },
			responses: ok({ items: { type: "integer" }, type: "array" }),
			summary: "Ends with a backslash \\",
			"x-honey-errors": {
				mro: status(409),
				_missing_: status(409),
				name: status(null),
				value: status(null),
				password: status(401),
				"a-b": status(422),
				a_b: status(422),
				"2fa": status(403),
				None: status(null),
				__init__: status(null),
			},
		},
	}
}

/** Methods named like builtins (`builtins` first in code-unit order), root ones too, and the `l`/`O`/`I` op. */
export function pythonPaths() {
	const binary = { content: { "application/octet-stream": { schema: { format: "binary", type: "string" } } } }
	return {
		"/py/builtins": { get: { operationId: "py.builtins", responses: ok(S) } },
		"/py/bytes": { get: { operationId: "py.bytes", responses: { 200: { ...binary, description: "ok" } } } },
		"/py/dict": {
			get: { operationId: "py.dict", responses: ok({ additionalProperties: { type: "integer" }, type: "object" }) },
		},
		"/py/int/{id}": { get: { operationId: "py.int", parameters: path("id"), responses: ok({ type: "integer" }) } },
		"/py/list": {
			get: { operationId: "py.list", parameters: [query("q")], responses: ok({ items: S, type: "array" }) },
		},
		"/py/object": { get: { operationId: "py.object", responses: ok({ type: "object" }) } },
		"/py/str/{id}": { get: { operationId: "py.str", parameters: path("id"), responses: ok(S) } },
		"/py/tuple": { get: { operationId: "py.tuple", responses: ok({ items: { type: "number" }, type: "array" }) } },
		"/py/zz/{id}": zzOp(),
		/* H48's v0 spelling: a non-hex `\u` is a SyntaxError in a non-raw docstring */
		"/py/l": {
			get: { operationId: "py.l", parameters: [query("O")], responses: ok(ref("I")), summary: 'C:\\users "quoted"' },
		},
		"/builtins": { get: { operationId: "builtins", responses: ok(S) } },
		"/str/{id}": { get: { operationId: "str", parameters: path("id"), responses: ok(S) } },
		"/zz/{id}": { get: { operationId: "zz", parameters: path("id"), responses: ok({ items: S, type: "array" }) } },
	}
}
