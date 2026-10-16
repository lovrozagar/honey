/**
 * The API's error keys in Rust (G6/G7): one `ErrorKey` enum over every key the API declares, in an operation's
 * `x-honey-errors` or as an error response's envelope keys, with `Other(String)` for any other; its wire
 * spelling (`as_str`, `Display`) and parse (`From<&str>`); `ApiError::key()`, which reads the runtime's raw key
 * into it, so the runtime never names a generated type (Fc4); and `<Key>Data` for a key whose own schema is
 * inline and not honey's envelope, the type `ApiError::decode_body` decodes its body into. Spec text reaches
 * the source only through the shared escape layer.
 */
import type { IRResponse, IRSchema } from "../../ir/model.ts"
import { irErrorEnvelope, isJsonMedia, type SdkModel } from "../../ir/sdk-model.ts"
import { lineComment, rustString } from "../shared/escape.ts"
import { compareCodeUnits, NameScope, rustTypeIdent } from "../shared/lang.ts"
import { type RustTypeContext, rustTopLevel } from "./types.ts"

/** The keys an error response's envelope names, over every operation's JSON error statuses (the runtime reads JSON only). */
function envelopeKeys(model: SdkModel): string[] {
	return model.ops.flatMap((op) =>
		op.errorStatuses.flatMap((status) => {
			/* an error status is a declared response, and a schema comes with the content type it is under */
			const { contentType, schema } = op.ir.responses[String(status)] as IRResponse
			if (schema === undefined || !isJsonMedia(contentType as string)) return []
			return irErrorEnvelope(schema, model.resolve)?.keys ?? []
		}),
	)
}

/**
 * Every declared key in code-unit order with its schema: `x-honey-errors`' (the first operation by id to
 * declare the key, so the document's path order never changes it), then an envelope's keys, which carry none.
 */
function declaredKeys(model: SdkModel): [string, IRSchema | undefined][] {
	const byId = [...model.ops].sort((a, b) => compareCodeUnits(a.id, b.id))
	const declared = byId.flatMap((op) => Object.entries(op.ir.extensions.errors ?? {}))
	/* reversed, so a key ends on its first declaration */
	const keys = new Map(declared.toReversed().map(([key, { schema }]) => [key, schema]))
	for (const key of envelopeKeys(model)) if (!keys.has(key)) keys.set(key, undefined)
	return [...keys].sort(([a], [b]) => compareCodeUnits(a, b))
}

/** What a body carrying `key` decodes into: its component, a new `<Key>Data`, or nothing to name (no schema, the envelope). */
function bodyType(key: string, schema: IRSchema | undefined, model: SdkModel, at: RustTypeContext): string | undefined {
	if (schema === undefined) return undefined
	if (schema.kind === "ref") return at.names.ref(schema.name)
	if (irErrorEnvelope(schema, model.resolve) !== null) return undefined
	const name = at.names.claim(`${rustTypeIdent(key)}Data`)
	at.decls.set(name, rustTopLevel(name, schema, at))
	return name
}

/** One declared key: its wire spelling, its variant, and the type its body decodes into. */
type Key = { readonly wire: string; readonly variant: string; readonly data: string | undefined }

/** The enum and its `as_str`, a variant per key and `Other` last. */
function enumLines(keys: readonly Key[]): string[] {
	const variants = keys.flatMap(({ data, variant, wire }) => {
		const decodes = data === undefined ? "" : `: its body decodes into [\`${data}\`] (\`ApiError::decode_body\`).`
		return [...lineComment(`\`${wire}\`${decodes}`, "///", "    "), `    ${variant},`]
	})
	return [
		"/// The error keys the API declares (G6): `ApiError::key()` reads one; any other key is `Other`.",
		"#[derive(Debug, Clone, PartialEq, Eq, Hash)]",
		"#[non_exhaustive]",
		"pub enum ErrorKey {",
		...variants,
		"    /// a key the API does not declare, as the server sent it",
		"    Other(String),",
		"}",
		"",
		"impl ErrorKey {",
		"    /// The key as the wire spells it.",
		"    pub fn as_str(&self) -> &str {",
		"        match self {",
		...keys.map(({ variant, wire }) => `            ErrorKey::${variant} => ${rustString(wire)},`),
		"            ErrorKey::Other(key) => key,",
		"        }",
		"    }",
		"}",
	]
}

/** `From<&str>`: a declared key's variant, any other `Other`; with no key declared, always `Other`. */
function fromLines(keys: readonly Key[]): string[] {
	const parse =
		keys.length === 0
			? ["        ErrorKey::Other(key.to_owned())"]
			: [
					"        match key {",
					...keys.map(({ variant, wire }) => `            ${rustString(wire)} => ErrorKey::${variant},`),
					"            other => ErrorKey::Other(other.to_owned()),",
					"        }",
				]
	return ["impl From<&str> for ErrorKey {", "    fn from(key: &str) -> Self {", ...parse, "    }", "}"]
}

/* Display as the wire spells it, and ApiError::key() over the runtime's raw key */
const TAIL = [
	"impl std::fmt::Display for ErrorKey {",
	"    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {",
	"        f.write_str(self.as_str())",
	"    }",
	"}",
	"",
	"impl crate::ApiError {",
	"    /// honey's error key in the body: the declared one it names, else `Other`; `None` without one.",
	"    pub fn key(&self) -> Option<ErrorKey> {",
	"        self.raw_key().map(ErrorKey::from)",
	"    }",
	"}",
]

/**
 * `ErrorKey` over every key `model` declares, its variants claimed in code-unit order beside `Other` (a
 * collision gets `…2`), each `<Key>Data` hoisted into `at.decls`; with no key, `Other` alone.
 */
export function rustErrorKeys(model: SdkModel, at: RustTypeContext): string {
	const variants = new NameScope(["Other"])
	const keys = declaredKeys(model).map(([wire, schema]) => ({
		data: bodyType(wire, schema, model, at),
		variant: variants.claim(rustTypeIdent(wire)),
		wire,
	}))
	return [...enumLines(keys), "", ...fromLines(keys), "", ...TAIL].join("\n")
}
