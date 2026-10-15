/**
 * A Go struct declaration and, when encoding/json needs help, its (un)marshal methods: for a key no
 * json tag can name, for the extra keys `additionalProperties` admits, for an embedded part that
 * (un)marshals itself (Go would promote its methods over the outer fields), and for a required
 * slice or map left nil (it would encode as null, which the schema does not allow).
 */
import { goString } from "../shared/escape.ts"
import { fillingMarshal, marshal, unmarshal } from "./types-codec.ts"

export type StructField = {
	goName: string
	/** the raw JSON key */
	key: string
	type: string
	required: boolean
	/** whether a json tag can name the key; an untagged field is (un)marshalled by hand */
	tagged: boolean
	/** optional and nullable: `Nullable[T]` under `omitzero` */
	triState: boolean
}

/** The field holding the keys `additionalProperties` admits beyond the declared ones. */
export type ExtraField = { goName: string; valueType: string }

/** What one struct declares: its embedded types, its fields in order, and its extra map. */
export type StructShape = {
	readonly embeds: readonly string[]
	readonly fields: readonly StructField[]
	/** an object's extra map; an allOf struct, the only one with embeds, never has one */
	readonly extra?: ExtraField | undefined
	/** whether an embed may (un)marshal itself: the struct then (un)marshals each embed on its own */
	readonly embedsEncode?: boolean
}

/* the punctuation encoding/json's isValidTag accepts in a tag name */
const TAG_PUNCTUATION = "!#$%&()*+-./:;<=>?@[]^_{|}~ "

/** Whether encoding/json reads `key` as a tag name (its isValidTag: a letter, a decimal digit or that punctuation). */
export function isTagName(key: string): boolean {
	return key !== "" && [...key].every((ch) => TAG_PUNCTUATION.includes(ch) || /[\p{L}\p{Nd}]/u.test(ch))
}

/** A struct tag holding `value`: the raw-string form, or an interpreted string when `value` has a backtick. */
const tagLiteral = (value: string) => (value.includes("`") ? goString(value) : `\`${value}\``)

/** The json tag encoding/json reads: the key and its option, a bare `-` spelled `-,` (alone it skips the field). */
function jsonTag(field: StructField): string {
	const value = field.triState ? `${field.key},omitzero` : field.required ? field.key : `${field.key},omitempty`
	return tagLiteral(`json:${goString(value === "-" ? "-," : value)}`)
}

/**
 * The field's tag on the declared struct. An untagged key's tag still names it for a tag reader
 * (reflect's `Tag.Get`), unless no reader could recover it: empty, or split at its comma.
 */
function tagOf(field: StructField): string {
	if (field.tagged) return jsonTag(field)
	const named = field.key !== "" && !field.key.includes(",")
	return named ? tagLiteral(`json:${goString(field.key)}`) : '`json:"-"`'
}

/** The field's tag on the copy the methods hand to encoding/json: an untagged key is skipped there. */
const plainTagOf = (field: StructField) => (field.tagged ? jsonTag(field) : '`json:"-"`')

/** The field lines of `shape`, each tagged by `tag`, the extra map last. */
function fieldLines(shape: StructShape, tag: (field: StructField) => string, indent: string): string[] {
	return [
		...shape.fields.map((f) => `${indent}${f.goName} ${f.type} ${tag(f)}`),
		...(shape.extra ? [`${indent}${shape.extra.goName} map[string]${shape.extra.valueType} \`json:"-"\``] : []),
	]
}

/** The copy of the struct the methods hand to encoding/json: the struct itself, or one without its embeds and untagged keys. */
function plainDecl(name: string, shape: StructShape): string[] {
	if (shape.embeds.length === 0 && shape.fields.every((f) => f.tagged)) return [`\ttype plain ${name}`]
	return ["\ttype plain struct {", ...fieldLines(shape, plainTagOf, "\t\t"), "\t}"]
}

/** `type <name> struct { … }` with its embeds, fields and extra map, then whatever methods its keys need. */
export function structDecl(name: string, shape: StructShape): string {
	const lines = [
		`type ${name} struct {`,
		...shape.embeds.map((embed) => `\t${embed}`),
		...fieldLines(shape, tagOf, "\t"),
		"}",
	]
	const filled = shape.fields.filter((f) => f.required && (f.type.startsWith("[]") || f.type.startsWith("map[")))
	if (shape.extra === undefined && shape.embedsEncode !== true && shape.fields.every((f) => f.tagged)) {
		if (filled.length > 0) lines.push("", ...fillingMarshal(name, filled))
	} else {
		const codec = { name, plain: plainDecl(name, shape), shape }
		lines.push("", ...unmarshal(codec), "", ...marshal(codec, filled))
	}
	return lines.join("\n")
}
