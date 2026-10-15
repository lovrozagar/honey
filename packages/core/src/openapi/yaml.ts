/**
 * A JSON-compatible YAML 1.2 emitter: the same document as `JSON.stringify`, in another encoding.
 * The value is first normalized through JSON (an undefined key is skipped, a Date is its ISO
 * string, NaN is null); then every string that is not plainly safe is written double-quoted, which
 * also reads the same under YAML 1.1 readers. Vendor-free: what a served `.yaml` is written with.
 */

const INDENT = "  "

/*
 * A plain scalar is used only for a conservative shape: it starts with a letter, `_`, `/` or `$`
 * and holds only word characters, `.`, `/`, `$`, `-`, `+`, `{}`, `()` and single inner spaces.
 * That excludes every indicator, `: `, ` #`, a leading digit (numbers, 1.1 octal and sexagesimal)
 * and `.inf`/`.nan`.
 */
const PLAIN = /^[A-Za-z_/$](?:[\w./${}()+-]| (?! ))*$/
/* words YAML 1.1 or 1.2 reads as null or a boolean */
const RESERVED = /^(?:y|n|yes|no|on|off|true|false|null|~)$/i
/* JSON string syntax is a YAML double-quoted scalar, but YAML forbids raw DEL, C1 bar NEL, the BOM and non-characters */
const UNPRINTABLE = /[\u007f-\u0084\u0086-\u009f﻿￾￿]/g

/** `value` as YAML, ending in a newline; `undefined` is `null`, as JSON has no nothing. */
export function toYaml(value: unknown): string {
	const json = JSON.stringify(value)
	return `${emit(json === undefined ? null : JSON.parse(json), 0)}\n`
}

function emit(value: unknown, indent: number): string {
	if (value === null || typeof value !== "object") return scalar(value)
	if (Array.isArray(value)) return emitArray(value, indent)
	return emitObject(value as Record<string, unknown>, indent)
}

/** A JSON scalar: null, a boolean, a number or a string. */
function scalar(value: unknown): string {
	return typeof value === "string" ? emitString(value) : String(value)
}

function emitString(value: string): string {
	return PLAIN.test(value) && !value.endsWith(" ") && !RESERVED.test(value) ? value : quote(value)
}

function quote(value: string): string {
	return JSON.stringify(value).replace(UNPRINTABLE, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

function isNonEmptyCollection(value: unknown): value is object {
	return value !== null && typeof value === "object" && Object.keys(value).length > 0
}

function emitArray(value: readonly unknown[], indent: number): string {
	if (value.length === 0) return "[]"
	const pad = INDENT.repeat(indent)
	const childPad = INDENT.repeat(indent + 1)
	return value
		.map((item) => {
			if (!isNonEmptyCollection(item)) return `${pad}- ${emit(item, 0)}`
			/* the item's first line, indented one level, moves up onto the dash */
			const lines = emit(item, indent + 1).split("\n")
			lines[0] = `${pad}- ${(lines[0] as string).slice(childPad.length)}`
			return lines.join("\n")
		})
		.join("\n")
}

function emitObject(value: Record<string, unknown>, indent: number): string {
	const keys = Object.keys(value)
	if (keys.length === 0) return "{}"
	const pad = INDENT.repeat(indent)
	return keys
		.map((key) => {
			const child = value[key]
			const name = emitString(key)
			return isNonEmptyCollection(child)
				? `${pad}${name}:\n${emit(child, indent + 1)}`
				: `${pad}${name}: ${emit(child, 0)}`
		})
		.join("\n")
}
