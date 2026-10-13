/**
 * The request path the router, scopes, `ctx.path`, `proxy()` and `staticFiles()` all see.
 *
 * Policy, applied the same way on every runtime:
 * - empty segments collapse: `//admin///users` is `/admin/users`
 * - dot segments resolve: `.` is dropped and `..` removes the segment before it, never past the
 *   root; `%2e` counts as a dot, as it does for WHATWG URL parsing
 * - a trailing slash is kept (the router and `trailingSlash()` decide what it means)
 * - a backslash is a `/`, and characters a URL path cannot hold raw (space, controls, `"`, `<`,
 *   `>`, `` ` ``, `{`, `}`, `^`, non-ASCII) are percent-encoded as UTF-8, so `ctx.path` does not
 *   depend on which runtime parsed the target
 * - an encoded `/` or `\` (`%2F`, `%5C`) is rejected unless `encodedSlashes` is `"allow"`: a
 *   segment that decodes to a separator means one thing here and another to whatever the path is
 *   forwarded to (a proxy upstream, a file system). Allowed, it stays encoded and decodes into a
 *   param value.
 * - everything else stays percent-encoded; params are decoded when they are extracted
 */

const PLAIN = 0
/* a character the rewrite changes: a backslash, or one encodeSegment percent-encodes */
const SLOW = 1
const PERCENT = 2
const SLASH = 3

type Verdict = "canonical" | "reject" | "rewrite"

/**
 * The WHATWG path percent-encode set, plus every non-ASCII code point. `^` joined the set in 2023;
 * it is encoded here so `ctx.path` does not depend on the runtime's URL parser version.
 */
function needsEncoding(c: number): boolean {
	return c <= 0x20 || c >= 0x7f || c === 34 || c === 60 || c === 62 || c === 94 || c === 96 || c === 123 || c === 125
}

function charClasses(): Uint8Array {
	const table = new Uint8Array(128)
	for (let c = 0; c < 128; c++) if (c === 92 || needsEncoding(c)) table[c] = SLOW
	table[37] = PERCENT
	table[47] = SLASH
	return table
}

/* ASCII → PLAIN | SLOW | PERCENT | SLASH; built once, never written after */
const CHAR_CLASS = /* @__PURE__ */ charClasses()

/** What the escape at `i` decodes to, as far as the policy cares. */
function escapeKind(raw: string, i: number): "dot" | "other" | "separator" {
	const hi = raw.charCodeAt(i + 1)
	const lo = raw.charCodeAt(i + 2) | 0x20
	if (hi === 50 /* 2 */) return lo === 102 /* f */ ? "separator" : lo === 101 /* e */ ? "dot" : "other"
	return hi === 53 /* 5 */ && lo === 99 /* c */ ? "separator" : "other"
}

/** One pass: is `raw` already canonical, rejected, or in need of the rewrite? */
function scan(raw: string, rejectEncoded: boolean): Verdict {
	let canonical = raw.charCodeAt(0) === 47
	for (let i = 0; i < raw.length; i++) {
		const c = raw.charCodeAt(i)
		const kind = c < 128 ? CHAR_CLASS[c] : SLOW
		if (kind === PLAIN) continue
		if (kind === SLOW) {
			canonical = false
		} else if (kind === PERCENT) {
			const escape = escapeKind(raw, i)
			if (escape === "separator" && rejectEncoded) return "reject"
			if (escape === "dot") canonical = false
		} else {
			/* `//` or a segment starting with a dot may collapse or resolve */
			const next = raw.charCodeAt(i + 1)
			if (next === 47 || next === 46) canonical = false
		}
	}
	return canonical ? "canonical" : "rewrite"
}

/** 1 for `.`, 2 for `..` (either may be written `%2e`), 0 for anything else. */
function dotSegment(seg: string): 0 | 1 | 2 {
	if (seg.length > 6) return 0
	const s = seg.toLowerCase().replaceAll("%2e", ".")
	return s === "." ? 1 : s === ".." ? 2 : 0
}

function rewrite(raw: string): string {
	const out: string[] = []
	const segments = raw.replaceAll("\\", "/").split("/")
	let trailing = false
	segments.forEach((seg, i) => {
		const last = i === segments.length - 1
		if (seg === "") {
			if (last && i > 0) trailing = true
			return
		}
		const dots = dotSegment(seg)
		if (dots === 0) {
			out.push(encodeSegment(seg))
			return
		}
		if (dots === 2) out.pop()
		/* `/a/b/..` is `/a/`, like URL resolution */
		if (last) trailing = true
	})
	if (out.length === 0) return "/"
	const path = `/${out.join("/")}`
	return trailing ? `${path}/` : path
}

/** The canonical request path, or `null` for a rejected one (the app answers 400). */
export function normalizePath(raw: string, encodedSlashes: "allow" | "reject" = "reject"): string | null {
	const verdict = scan(raw, encodedSlashes === "reject")
	if (verdict === "reject") return null
	return verdict === "canonical" ? raw : rewrite(raw)
}

/**
 * One path segment as a normalized request path holds it: characters a URL path cannot hold raw
 * become UTF-8 percent escapes, everything else (existing escapes included) is kept. Route
 * patterns encode their static segments with this too, so `app.get("/é")` matches the `/%C3%A9`
 * every runtime hands the app.
 */
export function encodeSegment(seg: string): string {
	let out = ""
	for (const ch of seg) {
		if (!needsEncoding(ch.codePointAt(0) as number)) {
			out += ch
			continue
		}
		try {
			out += encodeURIComponent(ch)
		} catch {
			/* a lone surrogate: U+FFFD, as URL parsing encodes it */
			out += "%EF%BF%BD"
		}
	}
	return out
}

/** Where the path of a request URL starts: after the authority, or 0 for an origin-form target. */
function pathStart(rawUrl: string): number {
	const protoEnd = rawUrl.indexOf("//")
	return protoEnd === -1 ? 0 : rawUrl.indexOf("/", protoEnd + 2)
}

/** The path of a request URL without `new URL()`: from the path start up to `?` or `#`. */
export function pathOfUrl(rawUrl: string): string {
	const start = pathStart(rawUrl)
	if (start === -1) return "/"
	for (let i = start; i < rawUrl.length; i++) {
		const c = rawUrl.charCodeAt(i)
		if (c === 63 /* ? */ || c === 35 /* # */) return rawUrl.substring(start, i)
	}
	return rawUrl.substring(start)
}

/** `?query` of a request URL (with the `?`), or `""`. Never includes a fragment. */
export function searchOfUrl(rawUrl: string): string {
	const start = pathStart(rawUrl)
	if (start === -1) return ""
	const q = rawUrl.indexOf("?", start)
	if (q === -1) return ""
	const hash = rawUrl.indexOf("#", q)
	return hash === -1 ? rawUrl.substring(q) : rawUrl.substring(q, hash)
}
