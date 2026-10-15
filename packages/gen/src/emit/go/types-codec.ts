/**
 * The (un)marshal methods a Go struct gets when encoding/json alone would get it wrong. Each struct
 * gets at most one MarshalJSON and one UnmarshalJSON: encoding/json handles a `plain` copy of the
 * struct, then the methods add what it cannot — the untagged keys, the extra keys, and each embedded
 * part on its own (its own methods would otherwise be promoted and drop the outer fields). On a key
 * both an embed and the struct itself encode, the struct's own field wins; a valid allOf has none.
 */
import { goString } from "../shared/escape.ts"
import type { StructField, StructShape } from "./types-struct.ts"

/** One struct as its methods see it: its name, its shape, and the declaration of its `plain` copy. */
export type Codec = { readonly name: string; readonly shape: StructShape; readonly plain: readonly string[] }

/** Whether a Go value of type `type` can be nil already, so an optional one needs no pointer. */
export function isNilable(type: string): boolean {
	return (
		type === "json.RawMessage" ||
		type === "interface{}" ||
		type.startsWith("*") ||
		type.startsWith("[]") ||
		type.startsWith("map[")
	)
}

const ERR_RETURN = ["\tif err != nil {", "\t\treturn nil, err", "\t}"]

/** An embed's field name: its type without the pointer. */
const embedField = (embed: string) => embed.replace(/^\*/, "")

/** `if p.F == nil { p.F = T{} }` for each required slice or map. */
function fillNil(fields: readonly StructField[]): string[] {
	return fields.flatMap((f) => [`\tif p.${f.goName} == nil {`, `\t\tp.${f.goName} = ${f.type}{}`, "\t}"])
}

/** MarshalJSON that only fills the required slices and maps a nil would encode as null. */
export function fillingMarshal(name: string, filled: readonly StructField[]): string[] {
	return [
		`func (s ${name}) MarshalJSON() ([]byte, error) {`,
		`\ttype plain ${name}`,
		"\tp := plain(s)",
		...fillNil(filled),
		"\treturn json.Marshal(p)",
		"}",
	]
}

/** The loop that decodes every undeclared key into the extra map. */
function extraDecode({ shape }: Codec): string[] {
	const extra = shape.extra
	if (extra === undefined) return []
	const known = shape.fields.map((f) => `${goString(f.key)}: true`).join(", ")
	return [
		`\tknown := map[string]bool{${known}}`,
		"\tfor k, v := range raw {",
		"\t\tif known[k] {",
		"\t\t\tcontinue",
		"\t\t}",
		`\t\tvar item ${extra.valueType}`,
		"\t\tif err := json.Unmarshal(v, &item); err != nil {",
		"\t\t\treturn err",
		"\t\t}",
		`\t\tif base.${extra.goName} == nil {`,
		`\t\t\tbase.${extra.goName} = map[string]${extra.valueType}{}`,
		"\t\t}",
		`\t\tbase.${extra.goName}[k] = item`,
		"\t}",
	]
}

/** The object as raw members, then each untagged key and the extra keys read from it by hand. */
function byHandDecode(codec: Codec): string[] {
	const untagged = codec.shape.fields.filter((f) => !f.tagged)
	if (untagged.length === 0 && codec.shape.extra === undefined) return []
	return [
		"\tvar raw map[string]json.RawMessage",
		"\tif err := json.Unmarshal(data, &raw); err != nil {",
		"\t\treturn err",
		"\t}",
		...untagged.flatMap((f) => [
			`\tif v, ok := raw[${goString(f.key)}]; ok {`,
			`\t\tif err := json.Unmarshal(v, &base.${f.goName}); err != nil {`,
			"\t\t\treturn err",
			"\t\t}",
			"\t}",
		]),
		...extraDecode(codec),
	]
}

/** UnmarshalJSON: the plain copy as encoding/json reads it, the by-hand keys, each embed from the whole object. */
export function unmarshal(codec: Codec): string[] {
	const { name, shape } = codec
	const embeds = shape.embeds.map(embedField)
	const store =
		embeds.length === 0 ? [`\t*s = ${name}(base)`] : shape.fields.map((f) => `\ts.${f.goName} = base.${f.goName}`)
	return [
		`func (s *${name}) UnmarshalJSON(data []byte) error {`,
		...codec.plain,
		"\tvar base plain",
		"\tif err := json.Unmarshal(data, &base); err != nil {",
		"\t\treturn err",
		"\t}",
		...byHandDecode(codec),
		...embeds.flatMap((embed) => [
			`\tif err := json.Unmarshal(data, &s.${embed}); err != nil {`,
			"\t\treturn err",
			"\t}",
		]),
		...store,
		"\treturn nil",
		"}",
	]
}

/** The loop adding each embed's own encoding under the keys the struct did not encode itself. */
function embedsEncode(embeds: readonly string[]): string[] {
	if (embeds.length === 0) return []
	return [
		`\tfor _, part := range []any{${embeds.map((embed) => `s.${embed}`).join(", ")}} {`,
		"\t\tencoded, err := json.Marshal(part)",
		...ERR_RETURN.map((line) => `\t${line}`),
		"\t\tvar members map[string]json.RawMessage",
		"\t\tif err := json.Unmarshal(encoded, &members); err != nil {",
		"\t\t\treturn nil, err",
		"\t\t}",
		"\t\tfor k, v := range members {",
		"\t\t\tif _, taken := out[k]; !taken {",
		"\t\t\t\tout[k] = v",
		"\t\t\t}",
		"\t\t}",
		"\t}",
	]
}

/** The loop adding each extra key the declared ones did not take. */
function extraEncode({ shape }: Codec): string[] {
	if (shape.extra === undefined) return []
	return [
		`\tfor k, v := range p.${shape.extra.goName} {`,
		"\t\tif _, taken := out[k]; taken {",
		"\t\t\tcontinue",
		"\t\t}",
		...["\tb, err := json.Marshal(v)", ...ERR_RETURN, "\tout[k] = b"].map((line) => `\t${line}`),
		"\t}",
	]
}

/** The statements that encode one untagged field into `out`, skipped while it is absent. */
function untaggedEncode(field: StructField): string[] {
	const guard = field.triState
		? `\tif !p.${field.goName}.IsZero() {`
		: isNilable(field.type)
			? `\tif p.${field.goName} != nil {`
			: undefined
	const indent = guard ? "\t" : ""
	const encode = [
		`\tif out[${goString(field.key)}], err = json.Marshal(p.${field.goName}); err != nil {`,
		"\t\treturn nil, err",
		"\t}",
	].map((line) => `${indent}${line}`)
	return guard ? [guard, ...encode, "\t}"] : encode
}

/** MarshalJSON: the plain copy as encoding/json writes it, then each embed's keys, the extra keys and the untagged ones. */
export function marshal(codec: Codec, filled: readonly StructField[]): string[] {
	const { name, shape } = codec
	const embeds = shape.embeds.map(embedField)
	const copy =
		embeds.length === 0 ? "plain(s)" : `plain{${shape.fields.map((f) => `${f.goName}: s.${f.goName}`).join(", ")}}`
	return [
		`func (s ${name}) MarshalJSON() ([]byte, error) {`,
		...codec.plain,
		`\tp := ${copy}`,
		...fillNil(filled),
		"\tencoded, err := json.Marshal(p)",
		...ERR_RETURN,
		"\tvar out map[string]json.RawMessage",
		"\tif err := json.Unmarshal(encoded, &out); err != nil {",
		"\t\treturn nil, err",
		"\t}",
		...embedsEncode(embeds),
		...extraEncode(codec),
		...shape.fields.filter((f) => !f.tagged).flatMap(untaggedEncode),
		"\treturn json.Marshal(out)",
		"}",
	]
}
