/**
 * JSON-compatible YAML 1.2 emitter: the same document as `JSON.stringify`, in a
 * different encoding. Input is first normalized through JSON (so `undefined` keys
 * are skipped, `Date` becomes its ISO string, `NaN` becomes `null`), then every
 * string that is not plainly safe is written as a double-quoted scalar, which
 * also reads the same under YAML 1.1 parsers.
 */

const INDENT = "  "

export function yamlSiblingPath(jsonPath: string): string {
	if (jsonPath.endsWith(".yaml") || jsonPath.endsWith(".yml")) return jsonPath.replace(/\.yml$/, ".yaml")
	return jsonPath.endsWith(".json") ? `${jsonPath.slice(0, -5)}.yaml` : `${jsonPath}.yaml`
}

/**
 * Where an OpenAPI output configured at `path` is written. A `.yaml`/`.yml` path is that YAML file
 * alone; any other path is JSON there plus its YAML sibling.
 */
export function openApiOutputPaths(path: string): { json: string | null; yaml: string } {
	if (path.endsWith(".yaml") || path.endsWith(".yml")) return { json: null, yaml: path }
	return { json: path, yaml: yamlSiblingPath(path) }
}

export function toYaml(value: unknown): string {
	const json = JSON.stringify(value)
	/* JSON.stringify(undefined) is undefined; emit the JSON equivalent of "nothing". */
	const normalized: unknown = json === undefined ? null : JSON.parse(json)
	return `${emit(normalized, 0)}\n`
}

function emit(value: unknown, indent: number): string {
	if (value === null) return "null"
	if (typeof value === "boolean") return value ? "true" : "false"
	if (typeof value === "number") return String(value)
	if (typeof value === "string") return emitString(value)
	if (Array.isArray(value)) return emitArray(value, indent)
	return emitObject(value as Record<string, unknown>, indent)
}

/*
 * A plain scalar is used only for a conservative shape: starts with a letter,
 * `_`, `/` or `$`; contains only word characters, `.`, `/`, `$`, `-`, `+`,
 * `{}`, `()` and inner spaces. That excludes every indicator, `: `, ` #`,
 * leading digits (numbers, YAML 1.1 octal and sexagesimal), and `.inf`/`.nan`.
 */
const PLAIN_RE = /^[A-Za-z_/$](?:[\w./${}()+-]| (?! ))*$/
/* Words YAML 1.1 or 1.2 resolves to null or a boolean. */
const RESERVED_RE = /^(?:y|n|yes|no|on|off|true|false|null|~)$/i

function emitString(value: string): string {
	if (PLAIN_RE.test(value) && !value.endsWith(" ") && !RESERVED_RE.test(value)) return value
	return quote(value)
}

/*
 * JSON string syntax is a valid YAML double-quoted scalar, except that YAML
 * forbids raw DEL, C1 controls (other than NEL) and the BOM/non-characters.
 */
function quote(value: string): string {
	return JSON.stringify(value).replace(
		/[\u007f-\u0084\u0086-\u009f﻿￾￿]/g,
		(ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
	)
}

function isNonEmptyCollection(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0
	return value !== null && typeof value === "object" && Object.keys(value).length > 0
}

function emitArray(value: unknown[], indent: number): string {
	if (value.length === 0) return "[]"
	const pad = INDENT.repeat(indent)
	const childPad = INDENT.repeat(indent + 1)
	return value
		.map((item) => {
			if (isNonEmptyCollection(item)) {
				const inner = emit(item, indent + 1)
				const lines = inner.split("\n")
				const first = lines[0]?.startsWith(childPad) ? lines[0].slice(childPad.length) : (lines[0] ?? "")
				return [`${pad}- ${first}`, ...lines.slice(1)].join("\n")
			}
			return `${pad}- ${emit(item, 0)}`
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
			const renderedKey = emitString(key)
			if (isNonEmptyCollection(child)) {
				return `${pad}${renderedKey}:\n${emit(child, indent + 1)}`
			}
			return `${pad}${renderedKey}: ${emit(child, 0)}`
		})
		.join("\n")
}
