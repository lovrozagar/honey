/**
 * The mutants the gen mutation harness swaps in for a guard: each is the guarded export with the one
 * defense it exists for taken out.
 */

/** A literal written as JSON writes it: no per-target policy, so U+2028, U+2029 and the BOM go raw. */
const asJson = (text: string): string => JSON.stringify(text)

/** escape.ts's literal writers without the policy table. */
export const bypassedEscapes = {
	goString: asJson,
	pyString: asJson,
	rustString: asJson,
	stringLiteral: asJson,
	tsString: asJson,
}

/** An ordering that depends on the machine's locale, not on code units. */
export const localeOrder = (a: string, b: string): number => a.localeCompare(b)

/** An object key written as the spec spelled it, never quoted. */
export const rawKey = (key: string): string => key

/* each language's constant-time digest compare, and the value compare a careless helper writes instead */
const VALUE_COMPARE: readonly (readonly [RegExp, string])[] = [
	[/CryptographicOperations\.FixedTimeEquals\(expected, given\)/, "expected.SequenceEqual(given)"],
	[/hmac\.Equal\(expected, given\)/, "bytes.Equal(expected, given)"],
	[/MessageDigest\.isEqual\(expected, given\)/, "java.util.Arrays.equals(expected, given)"],
	[/hmac\.compare_digest\(expected, given\)/, "expected == given"],
	[/expected\.ct_eq\(&given\)\.into\(\)/, "expected == given"],
	[/timingSafeEqual\(expected, given\)/, "expected.equals(given)"],
]

/** A verify helper whose digest compare stops at the first differing byte: a timing oracle. */
export function variableTimeHelper(verifyHelper: (language: string) => string): (language: string) => string {
	return (language) =>
		VALUE_COMPARE.reduce((text, [constantTime, value]) => text.replace(constantTime, value), verifyHelper(language))
}

/** `text` with `from` replaced by `to`; a patch that no longer matches throws (a stale mutant is red). */
function patched(text: string, [from, to]: readonly [string, string], where = "the runtime"): string {
	if (!text.includes(from)) throw new Error(`stale runtime mutant: ${JSON.stringify(from)} is not in ${where}`)
	return text.replace(from, to)
}

/** `runtimeSource` with each `[from, to]` applied to the text; a patch that no longer matches throws (a stale mutant is red). */
export function patchedRuntime(
	runtimeSource: () => string,
	patches: readonly (readonly [string, string])[],
): () => string {
	return () => patches.reduce((text, patch) => patched(text, patch), runtimeSource())
}

/** `runtimeFiles` with each `[file, from, to]` applied to that file; a patch whose file is not shipped or whose text is gone throws. */
export function patchedRuntimeFiles<A extends readonly unknown[]>(
	runtimeFiles: (...args: A) => Record<string, string>,
	patches: readonly (readonly [string, string, string])[],
): (...args: A) => Record<string, string> {
	return (...args) =>
		patches.reduce(
			(files, [file, from, to]) => {
				const text = files[file]
				if (text === undefined) throw new Error(`stale runtime mutant: ${file} is not shipped`)
				return { ...files, [file]: patched(text, [from, to], file) }
			},
			runtimeFiles(...args),
		)
}

/* a cross-origin hop that keeps every header, credentials and the auth header included */
export const KEEP_CROSS_ORIGIN_HEADERS = [
	[
		"if (crossOrigin) next.headers = crossOriginHeaders(next.headers as Headers)",
		"if (crossOrigin) next.headers = new Headers(next.headers as Headers)",
	],
] as const

/* a path param written as it came: no percent-encoding, no refusal of a dot segment */
export const RAW_PATH_PARAMS = [
	['if (value === "" || value === "." || value === "..") {', "if (false) {"],
	["return encodeURIComponent(value)\n}", "return value\n}"],
] as const

/* an onLog entry naming the full request URL and the auth header instead of the path template */
export const LEAKY_LOG = [
	[
		"exchangeLog(this.#config.onLog, `${method.toUpperCase()} ${path}`)",
		'exchangeLog(this.#config.onLog, `${method.toUpperCase()} ${url.toString()} ${headers.get("authorization") ?? ""}`)',
	],
] as const

/* a Go cross-origin hop that keeps every header: the strip loop deletes nothing (the same-origin refusal stays) */
export const GO_KEEP_CROSS_ORIGIN_HEADERS = [
	["redirect.go", "\t\t\tdelete(req.Header, name)\n", "\t\t\tcontinue\n"],
] as const

/* a Go path param written as it came: no percent-encoding, no refusal of an empty or dot segment */
export const GO_RAW_PATH_PARAMS = [
	["path.go", 'if value == "" || value == "." || value == ".." {', "if false {"],
	["path.go", "return escapePathSegment(value), nil", "return value, nil"],
] as const

/* a Go OnLog response entry naming the full request URL and the auth header instead of METHOD /template */
export const GO_LEAKY_LOG = [
	[
		"request.go",
		'Event: "response_received", Operation: x.c.operation,',
		'Event: "response_received", Operation: x.c.method + " " + result.resp.Request.URL.String() + " " + result.resp.Request.Header.Get("Authorization"),',
	],
] as const

/* a Rust cross-origin hop that keeps every header: the allowlist made, then merged back over what it strips (the same-origin refusal stays) */
export const RUST_KEEP_CROSS_ORIGIN_HEADERS = [
	["redirect.rs", "        hop.headers = kept;\n", "        hop.headers.extend(kept);\n"],
] as const

/* a Rust path param written with `/` and dot segments as they came: no refusal, no encoded slash */
export const RUST_RAW_PATH_PARAMS = [
	["path.rs", 'if value.is_empty() || value == "." || value == ".." {', "if false {"],
	["path.rs", "Ok(escape_segment(value))", 'Ok(escape_segment(value).replace("%2F", "/"))'],
] as const

/* a Rust log entry naming the filled path, the query and the token instead of METHOD /template */
export const RUST_LEAKY_LOG = [
	[
		"exchange.rs",
		"CallLog::new(inner.on_log.as_ref(), spec.operation())",
		'CallLog::new(inner.on_log.as_ref(), format!("{} {}?{:?} {:?}", spec.method, spec.path, spec.query, inner.auth.current().await))',
	],
] as const

/* a Python cross-origin hop that keeps every header: the follow keeps them, and the send strips nothing (the same-origin refusal and the auth reset stay) */
export const PYTHON_KEEP_CROSS_ORIGIN_HEADERS = [
	[
		"redirect.py",
		"        headers = {k: v for k, v in headers.items() if k.lower() in SAFE}\n",
		"        headers = dict(headers)\n",
	],
	["redirect.py", "    for name in foreign(request.headers):\n", "    for name in foreign([]):\n"],
] as const

/* a Python path param written with `/` and dot segments as they came: no refusal, no encoded slash */
export const PYTHON_RAW_PATH_PARAMS = [
	["path.py", 'if found is None or found in ("", ".", ".."):', "if found is None:"],
	["path.py", 'return quote(found, safe="!~*\'()")', 'return quote(found, safe="/!~*\'()")'],
] as const

/* a Python log entry naming the filled URL with its query and the token instead of METHOD /template */
export const PYTHON_LEAKY_LOG = [
	[
		"exchange.py",
		'self.log = CallLog(core.config.on_log, f"{op.method} {op.path}")',
		'self.log = CallLog(core.config.on_log, f"{op.method} {self.url()} {core.auth.token}")',
	],
] as const

/*
 * A C# cross-origin hop that keeps every header. Two sites, each proven alone by Q-f3: StripHandler (Handler.cs), the
 * innermost strip that runs after any caller HttpMessageHandler chain, is what caller-chain legs kill; the follow's
 * header set (Redirect.cs) is defense-in-depth, equivalent under StripHandler and not counted as its own kill.
 */
export const CSHARP_KEEP_CROSS_ORIGIN_HEADERS = [
	["Redirect.cs", " && (!cross || Safe.Contains(name, StringComparer.OrdinalIgnoreCase))", ""],
	["Handler.cs", "out var cross) && cross)", "out var cross) && cross && false)"],
] as const

/* a C# path param written as it came: no refusal of an empty, a dot or a dot-dot value, and a `/` left unencoded */
export const CSHARP_RAW_PATH_PARAMS = [
	["Path.cs", 'return value is null or "" or "." or ".."', "return value is null"],
	["Path.cs", `"-_.!~*'()".Contains((char)b)`, `"-_.!~*'()/".Contains((char)b)`],
] as const

/* a C# operation log entry naming the filled URL with its query and the token instead of METHOD /template */
export const CSHARP_LEAKY_LOG = [
	[
		"Exchange.cs",
		'$"{op.Method} {op.Path}")',
		'$"{op.Method} {client.Base}{UrlPath.Expand(op, call.Path)}?{UrlQuery.Encode(call.Query)} {client.Auth.Token}")',
	],
] as const
