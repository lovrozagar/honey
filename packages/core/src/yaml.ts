/** JSON-compatible YAML 1.2 emitter — same document as JSON.stringify, different encoding. */

const INDENT = "  "

export function yamlSiblingPath(jsonPath: string): string {
	return jsonPath.endsWith(".json") ? `${jsonPath.slice(0, -5)}.yml` : `${jsonPath}.yml`
}

export function toYaml(value: unknown): string {
	return `${emit(value, 0)}\n`
}

function emit(value: unknown, indent: number): string {
	if (value === null || value === undefined) return "null"
	if (typeof value === "boolean") return value ? "true" : "false"
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return JSON.stringify(String(value))
		return Object.is(value, -0) ? "-0" : String(value)
	}
	if (typeof value === "string") return emitString(value)
	if (Array.isArray(value)) return emitArray(value, indent)
	if (typeof value === "object") return emitObject(value as Record<string, unknown>, indent)
	return JSON.stringify(String(value))
}

function emitString(value: string): string {
	if (value === "") return '""'
	if (needsQuotes(value)) return JSON.stringify(value)
	return value
}

function needsQuotes(value: string): boolean {
	if (/^[-?:{},[\],&*#|!>'%@`]/.test(value)) return true
	if (/[\n\r\t]/.test(value)) return true
	if (/^\s|\s$/.test(value)) return true
	if (value.includes(": ") || value.includes(" #")) return true
	if (/^(true|false|null|yes|no|on|off)$/i.test(value)) return true
	if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return true
	if (/^\d/.test(value)) return true
	return false
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
			const renderedKey = needsQuotes(key) || key === "" ? JSON.stringify(key) : key
			if (isNonEmptyCollection(child)) {
				return `${pad}${renderedKey}:\n${emit(child, indent + 1)}`
			}
			return `${pad}${renderedKey}: ${emit(child, 0)}`
		})
		.join("\n")
}
