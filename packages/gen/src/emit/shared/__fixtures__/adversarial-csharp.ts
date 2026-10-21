/**
 * C#'s hostile names for the shared adversarial corpus (bit 15), merged over `adversarialCorpus()` so the C# emitter
 * compiles the shared document plus these: the C# keywords no identifier but `@` can spell, and the contextual words
 * (`field` among them), as path params; the record members a property may spell, `Clone` included (CS8859), each by
 * its synthesized or inherited name; a component named like the member it shadows, `Widget` with a `widget` property
 * (CS0542); PascalCase collisions; the BCL names the runtime spells unqualified (CS0115 on a component
 * `HttpRequestMessage`); an enum whose members are the inherited method names; error keys that are `finalize`; the
 * `\u` and `\x` spellings; a lowercase component (CS8981); and U+FFFE and U+FFFF in a `///` doc and a string literal.
 * U+FFFE and U+FFFF are each a CS1570 in a doc on the pinned SDK; the doc writer hides both at step 2.
 * Made on use: a module under `src` runs no code as it loads. It imports the shared corpus and nothing imports back,
 * so the shared corpus stays shared (R-f1).
 */
import { adversarialCorpus } from "./adversarial-corpus.ts"

const S = { type: "string" }
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const ok = (schema: unknown) => ({ 200: { ...json(schema), description: "ok" } })
const path = (...names: string[]) => names.map((name) => ({ in: "path", name, required: true, schema: S }))
const status = (code: number) => ({ status: code })
const words = (text: string) => [...new Set(text.split(" "))]
const obj = (names: string[], description?: string) => ({
	...(description === undefined ? {} : { description }),
	properties: Object.fromEntries(names.map((name) => [name, S])),
	type: "object",
})

/* C#'s keywords (reserved and contextual, `field` among them), and the method's own `cancellation_token` and `options` */
export const CS_LOCALS =
	"abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while add alias ascending async await by descending dynamic equals field file from get global group init into join let managed nameof nint not notnull nuint on or orderby partial record remove required scoped select set unmanaged value var when where with yield cancellation_token options"

/* every member a record has, synthesized or inherited (RECORD_MEMBERS, types-record.ts), and `Clone`, which CS8859 disallows */
const RECORD_KEYS =
	"clone deconstruct equality_contract equals finalize get_hash_code get_type json_ignore_condition memberwise_clone print_members to_string"

/* the BCL names the runtime spells unqualified (its `using` lines): a component of such a name shadows it */
const RUNTIME_BCL =
	"HttpClient HttpRequestMessage HttpResponseMessage Uri Stream Encoding Timeout CancellationTokenSource Stopwatch Interlocked MemoryStream Guid Convert Math StringBuilder Dictionary List Action"

/* the names the reservation already covers (types-names.ts), kept as clean-build inputs */
const RESERVED_NAMES = "Task CancellationToken JsonElement System Exception Type"

/* the `///` and string-literal non-characters: U+FFFE is a CS1570 in a doc (hidden by the emitter), U+FFFF is hidden there too */
const NONCHARS = {
	Mode: {
		enum: [
			"to_string",
			"equals",
			"get_hash_code",
			"get_type",
			"parse",
			"format",
			"get_name",
			"has_flag",
			"nonchar\uFFFEx",
		],
		type: "string",
	},
	Nonchar: {
		description: "doc\uFFFEline",
		properties: { a: { description: "property\uFFFE", type: "string" } },
		type: "object",
	},
	Tripwire: /* @__PURE__ */ obj(["a"], "doc\uFFFFline"),
}

/** One GET per component: the component's ref, under its lowercase path and operation id. */
function componentPaths(names: readonly string[]): Record<string, unknown> {
	return Object.fromEntries(
		names.map((name) => {
			const lower = name.toLowerCase()
			return [`/csharp/${lower}`, { get: { operationId: `csharp.${lower}`, responses: ok(ref(name)) } }]
		}),
	)
}

/** The components: records of hostile member names, the enum and the non-characters, then each shadowing name. */
export function csharpSchemas(): Readonly<Record<string, unknown>> {
	return {
		Members: obj(words(RECORD_KEYS)),
		Widget: obj(["widget"]),
		Collide: obj(["foo_bar", "fooBar", "FooBar"]),
		...NONCHARS,
		/* `\u` and `\x` spellings as keys: an identifier keeps only its alphanumerics, a literal keeps them as text */
		Escapes: obj(["\\u0041", "\\u{41}", "\\x41"]),
		lowercase: obj(["a"]),
		...Object.fromEntries(words(RUNTIME_BCL).map((name) => [name, obj(["a"])])),
		...Object.fromEntries(words(RESERVED_NAMES).map((name) => [name, obj(["a"])])),
	}
}

/** The locals op, the error op (keys that collide once PascalCased, `finalize` among them), and a GET per component. */
export function csharpPaths(): Readonly<Record<string, unknown>> {
	const locals = words(CS_LOCALS)
	return {
		[`/csharp/locals/${locals.map((name) => `{${name}}`).join("/")}`]: {
			get: { operationId: "csharp.locals", parameters: path(...locals), responses: ok(S) },
		},
		"/csharp/errors": {
			get: {
				operationId: "csharp.errors",
				responses: ok(S),
				"x-honey-errors": {
					finalize: status(409),
					foo_bar: status(409),
					fooBar: status(422),
					"error-key": status(403),
				},
			},
		},
		...componentPaths([
			"Members",
			"Widget",
			"Collide",
			...Object.keys(NONCHARS),
			"Escapes",
			"lowercase",
			...words(RUNTIME_BCL),
			...words(RESERVED_NAMES),
		]),
	}
}

/** The shared corpus with C#'s names merged in: the one document the C# gates compile, in both throwOnError modes. */
export function csharpCorpus(): Readonly<Record<string, unknown>> {
	const base = adversarialCorpus() as Readonly<{
		components: { schemas: Readonly<Record<string, unknown>> }
		paths: Readonly<Record<string, unknown>>
	}>
	return {
		...base,
		components: { schemas: { ...base.components.schemas, ...csharpSchemas() } },
		paths: { ...base.paths, ...csharpPaths() },
	}
}

/**
 * The non-characters alone: a doc diagnostic (CS1570) is masked by any other error in its compilation, so U+FFFE's
 * red shows only here, and U+FFFF's clean build is proven without a masking error beside it.
 */
export function csharpDocCorpus(): Readonly<Record<string, unknown>> {
	return {
		components: { schemas: NONCHARS },
		info: { title: "non-characters", version: "1.0.0" },
		openapi: "3.1.0",
		paths: componentPaths(Object.keys(NONCHARS)),
	}
}
