const PLAIN = 0
/** a character the slow path rewrites: a backslash, or one `encodeSegment` percent-encodes */
const SLOW = 1
const PERCENT = 2
const SLASH = 3

const CHAR_CLASS = new Uint8Array(128)
for (let c = 0; c < 128; c++) {
	if (c <= 0x20 || c === 0x7f || c === 92 || needsEncoding(c)) CHAR_CLASS[c] = SLOW
}
CHAR_CLASS[37] = PERCENT
CHAR_CLASS[47] = SLASH

/**
 * The request path the router, scopes, `ctx.path`, `proxy()` and `staticFiles()` all see.
 *
 * Policy, applied the same way on every runtime:
 * - empty segments collapse: `//admin///users` is `/admin/users`
 * - dot segments resolve: `.` is dropped and `..` removes the segment before it, never past
 *   the root; `%2e` counts as a dot, as it does for WHATWG URL parsing
 * - a trailing slash is kept (the router and `trailingSlash()` decide what it means)
 * - a backslash is a `/`, and characters a URL path cannot hold raw (space, controls, `"`, `<`,
 *   `>`, `` ` ``, `{`, `}`, non-ASCII) are percent-encoded as UTF-8 — what WHATWG URL parsing
 *   does, so a runtime that hands the app the raw target (Deno) and one that parses it first
 *   (Bun, Node) route the same bytes the same way
 * - an encoded `/` or `\` (`%2F`, `%5C`) is rejected unless `encodedSlashes` is `"allow"`: a
 *   segment that decodes to a path separator means one thing to this router and another to
 *   whatever the path is forwarded to (a proxy upstream, a file system). Allowed, it stays
 *   encoded in the path and decodes into a param value.
 * - everything else stays percent-encoded; params are decoded when they are extracted
 *
 * Returns `null` for a rejected path; the app answers 400.
 */
export function normalizePath(raw: string, encodedSlashes: "allow" | "reject" = "reject"): string | null {
	const rejectEncoded = encodedSlashes === "reject"
	let canonical = raw.charCodeAt(0) === 47
	const len = raw.length
	for (let i = 0; i < len; i++) {
		const c = raw.charCodeAt(i)
		const k = c < 128 ? CHAR_CLASS[c] : SLOW
		if (k === PLAIN) continue
		if (k === SLOW) {
			canonical = false
		} else if (k === PERCENT) {
			const hi = raw.charCodeAt(i + 1)
			const lo = raw.charCodeAt(i + 2) | 0x20
			if (hi === 50 /* 2 */) {
				if (lo === 102 /* f */ && rejectEncoded) return null
				if (lo === 101 /* e */) canonical = false
			} else if (hi === 53 /* 5 */ && lo === 99 /* c */ && rejectEncoded) {
				return null
			}
		} else {
			const n = raw.charCodeAt(i + 1)
			if (n === 47 || n === 46 /* . */) canonical = false
		}
	}
	if (canonical) return raw

	const out: string[] = []
	const segments = raw.replaceAll("\\", "/").split("/")
	let trailing = false
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]
		const last = i === segments.length - 1
		if (seg === "") {
			if (last && i > 0) trailing = true
			continue
		}
		const dots = dotSegment(seg)
		if (dots === 0) {
			out.push(encodeSegment(seg))
			continue
		}
		if (dots === 2) out.pop()
		/* `/a/b/..` is `/a/`, like URL resolution */
		if (last) trailing = true
	}
	if (out.length === 0) return "/"
	const path = `/${out.join("/")}`
	return trailing ? `${path}/` : path
}

/**
 * The WHATWG path percent-encode set, plus every non-ASCII code unit. `^` joined the set in
 * 2023; Node and Bun encode it, Deno's parser does not yet, so it is encoded here to keep
 * `ctx.path` the same on all three.
 */
function needsEncoding(c: number): boolean {
	return (
		c <= 0x20 ||
		c >= 0x7f ||
		c === 34 /* " */ ||
		c === 60 /* < */ ||
		c === 62 /* > */ ||
		c === 94 /* ^ */ ||
		c === 96 /* ` */ ||
		c === 123 /* { */ ||
		c === 125 /* } */
	)
}

/**
 * One path segment as a normalized request path holds it: characters a URL path cannot hold
 * raw become UTF-8 percent escapes, everything else (existing escapes included) is kept.
 * Route patterns encode their static segments with this too, so `app.get("/é")` matches the
 * `/%C3%A9` every runtime hands the app.
 */
export function encodeSegment(seg: string): string {
	let needs = false
	for (let i = 0; i < seg.length; i++) {
		if (needsEncoding(seg.charCodeAt(i))) {
			needs = true
			break
		}
	}
	if (!needs) return seg
	let out = ""
	for (const ch of seg) {
		const c = ch.charCodeAt(0)
		if (ch.length === 1 && !needsEncoding(c)) {
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

/** 1 for `.`, 2 for `..` (either may be written `%2e`), 0 for anything else. */
function dotSegment(seg: string): 0 | 1 | 2 {
	if (seg.length > 6) return 0
	const s = seg.toLowerCase().replaceAll("%2e", ".")
	if (s === ".") return 1
	if (s === "..") return 2
	return 0
}

/** The path of a request URL without `new URL()`: everything from the first `/` after the authority, up to `?` or `#`. */
export function pathOfUrl(rawUrl: string): string {
	const protoEnd = rawUrl.indexOf("//")
	const pathStart = protoEnd === -1 ? 0 : rawUrl.indexOf("/", protoEnd + 2)
	if (pathStart === -1) return "/"
	for (let i = pathStart; i < rawUrl.length; i++) {
		const c = rawUrl.charCodeAt(i)
		if (c === 63 /* ? */ || c === 35 /* # */) return rawUrl.substring(pathStart, i)
	}
	return rawUrl.substring(pathStart)
}

/** `?query` of a request URL (with the `?`), or `""`. Never includes a fragment. */
export function searchOfUrl(rawUrl: string): string {
	const protoEnd = rawUrl.indexOf("//")
	const pathStart = protoEnd === -1 ? 0 : rawUrl.indexOf("/", protoEnd + 2)
	if (pathStart === -1) return ""
	const q = rawUrl.indexOf("?", pathStart)
	if (q === -1) return ""
	const hash = rawUrl.indexOf("#", q)
	return hash === -1 ? rawUrl.substring(q) : rawUrl.substring(q, hash)
}
