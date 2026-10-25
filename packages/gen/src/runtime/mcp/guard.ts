/**
 * A tool call's guards (bit 18), run before anything is sent, each refusal naming the argument: a `__proto__`,
 * `constructor` or `prototype` key at any depth; a value its inputSchema rejects; a path value holding `/` or `\`, or
 * `.` or `..`, as given or after any number of percent-decodings (H18.11). And the API key, as given, URL-encoded or
 * form-encoded, scrubbed from every string of a result, keys included.
 */

/** A tool's JSON Schema: the keywords schema.ts emits that constrain a value, every one checked here. */
type Schema = {
	readonly type?: string
	readonly enum?: readonly unknown[]
	readonly const?: unknown
	readonly anyOf?: readonly Schema[]
	readonly allOf?: readonly Schema[]
	readonly properties?: Readonly<Record<string, Schema>>
	readonly required?: readonly string[]
	readonly additionalProperties?: Schema | false
	readonly items?: Schema | false
	readonly prefixItems?: readonly Schema[]
	readonly minItems?: number
}

/** `key` under the path `at`. */
const under = (at: string, key: string) => (at ? `${at}.${key}` : key)

/** The first key in `value` naming a prototype, as its path under `at`. */
function prototypeKey(value: unknown, at: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined
	for (const [key, item] of Object.entries(value)) {
		const path = Array.isArray(value) ? `${at}[${key}]` : under(at, key)
		const found =
			!Array.isArray(value) && /^(?:__proto__|constructor|prototype)$/.test(key) ? path : prototypeKey(item, path)
		if (found) return found
	}
	return undefined
}

const typeOf = (value: unknown) =>
	value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Why the array `list`, at `at`, fails `schema`'s items. */
function itemsInvalid(schema: Schema, list: readonly unknown[], at: string): string | undefined {
	if (list.length < (schema.minItems ?? 0)) return `${at} has too few items`
	return list
		.map((item, index) => {
			const of = schema.prefixItems?.[index] ?? schema.items
			return of === false ? `${at}[${index}] is past the last item` : of && invalid(of, item, `${at}[${index}]`)
		})
		.find(Boolean)
}

/** Why the object `object`, at `at`, fails `schema`'s properties. */
function fieldsInvalid(schema: Schema, object: Record<string, unknown>, at: string): string | undefined {
	const missing = schema.required?.find((name) => !Object.hasOwn(object, name))
	if (missing) return `${under(at, missing)} is required`
	const { additionalProperties, properties = {} } = schema
	return Object.entries(object)
		.map(([name, item]) => {
			const of = Object.hasOwn(properties, name) ? properties[name] : additionalProperties
			return of === false ? `${under(at, name)} is not a declared property` : of && invalid(of, item, under(at, name))
		})
		.find(Boolean)
}

/** Why `value`, of `type`, fails `schema`'s own keywords: its type, enum, const and anyOf. */
function ownInvalid(schema: Schema, value: unknown, type: string, at: string): string | undefined {
	const where = at || "arguments"
	if (schema.type && schema.type !== type && !(schema.type === "number" && type === "integer"))
		return `${where} must be ${schema.type}`
	if (schema.enum && !schema.enum.some((option) => same(option, value)))
		return `${where} must be one of ${JSON.stringify(schema.enum)}`
	if ("const" in schema && !same(schema.const, value)) return `${where} must be ${JSON.stringify(schema.const)}`
	if (schema.anyOf && !schema.anyOf.some((option) => !invalid(option, value, at)))
		return `${where} matches none of its schemas`
	return undefined
}

/** Why `value`, at `at`, fails `schema`; undefined when it conforms. */
function invalid(schema: Schema, value: unknown, at: string): string | undefined {
	const type = typeOf(value)
	const where = at || "arguments"
	const own = ownInvalid(schema, value, type, at) ?? schema.allOf?.map((one) => invalid(one, value, at)).find(Boolean)
	if (own || (type !== "array" && type !== "object")) return own
	return type === "array"
		? itemsInvalid(schema, value as unknown[], where)
		: fieldsInvalid(schema, value as Record<string, unknown>, at)
}

/** Whether a path value could leave its segment, as given or after any number of percent-decodings. */
function leavesSegment(value: string): boolean {
	for (let text = value, last = ""; text !== last;) {
		if (/[/\\]|^\.\.?$/.test(text)) return true
		last = text
		text = text.replace(/%([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
	}
	return false
}

/** Why `args` are refused, naming the argument; `paths` are the path parameters' properties. */
export function refusal(
	inputSchema: Schema,
	paths: readonly string[],
	args: Record<string, unknown>,
): string | undefined {
	const prototype = prototypeKey(args, "")
	const leaving = paths.find((property) => args[property] !== undefined && leavesSegment(String(args[property])))
	const why = prototype
		? `${prototype} names a prototype`
		: (invalid(inputSchema, args, "") ?? (leaving && `${leaving} must stay within one path segment`))
	return why && `Invalid arguments: ${why}`
}

/** A scrubber of `secret` from every string in a value, keys included, in any letter case (a hex escape's either). */
export function redactor(secret: string): (value: unknown) => unknown {
	if (!secret) return (value) => value
	const forms = [secret, encodeURIComponent(secret), new URLSearchParams({ s: secret }).toString().slice(2)]
	const pattern = new RegExp(forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi")
	const scrub = (value: unknown): unknown =>
		typeof value === "string"
			? value.replace(pattern, "[redacted]")
			: typeof value !== "object" || value === null
				? value
				: Array.isArray(value)
					? value.map(scrub)
					: Object.fromEntries(Object.entries(value).map(([key, item]) => [scrub(key) as string, scrub(item)]))
	return scrub
}
