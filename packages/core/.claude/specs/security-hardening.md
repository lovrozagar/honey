# Security Hardening

## Goal

Close the security gaps vs Hono/Elysia. Four items — each independently valuable, no dependencies between them.

## Approach

RED → CODE → GREEN. No shortcuts.

1. Write ALL tests first — internal + consumer.
2. Run tests. Every one must FAIL (RED).
3. Only after all REDs confirmed: implement.
4. Run tests. Every one must PASS (GREEN).
5. Full suite. Zero regressions.

All new exports are separate entry points for tree-shaking. Nothing goes in `index.ts`.

---

## Implementation Order

1. **Prototype pollution guard** — fixes actual vulnerability, 5-line change
2. **Timing-safe comparison** — foundational utility
3. **Cookie prefixes** — trivial validation, high value
4. **IP restriction** — new middleware, moderate complexity

---

## 1. Prototype Pollution Guard in Form Parsing

### Why

**Real vulnerability** in current code. `validation.ts` form parsing:

```typescript
formData.forEach((value, key) => {
	formRecord[key] = value /* __proto__, constructor, prototype — all accepted */
})
```

An attacker submitting `__proto__` as a form field name can pollute `Object.prototype`. Elysia blocks this explicitly.

### Design

Exact key match only — no substring check. Honey doesn't parse nested form keys (dot notation), so only top-level exact matches are dangerous:

```typescript
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"])

formData.forEach((value, key) => {
	if (DANGEROUS_KEYS.has(key)) return
	formRecord[key] = value
})
```

Silent skip (not throw) because:

- Throwing gives attackers an oracle
- Skipping is safe — key is never set
- Schema validator catches missing required fields

Apply in all form parsing branches (declared, stream, standard, urlencoded).

### Tests

**Internal:**

- `__proto__` form field silently dropped
- `constructor` form field silently dropped
- `prototype` form field silently dropped
- Normal fields unaffected
- Field named `my__proto__field` NOT blocked (exact match only)

**Consumer:**

- Form POST with `__proto__` field → field absent from parsed input, no pollution

### Files

| File                | Change                                            |
| ------------------- | ------------------------------------------------- |
| `src/validation.ts` | Add dangerous key check in all form parsing loops |
| Tests               | `tests/unit/validation/validation.test.ts`        |

---

## 2. Timing-Safe Comparison Utility

### Why

Any app comparing secrets (API keys, webhook signatures, tokens) needs constant-time comparison. `if (token === expected)` is vulnerable — attacker measures response times to guess tokens character-by-character. Hono provides `timingSafeEqual`. Elysia uses `crypto.timingSafeEqual`.

Honey's cookie signing uses `crypto.subtle.verify` (timing-safe by spec), but there's no general-purpose utility for user code.

### Design

```typescript
export async function timingSafeEqual(a: string, b: string): Promise<boolean>
```

HMAC-based: sign both values with the same key, compare signatures via `crypto.subtle.verify`. Works on all runtimes (CF Workers, Deno, Bun, Node) — no Node `crypto` dependency.

Cache the HMAC key at module level (lazily initialized on first call) to avoid key generation overhead per comparison:

```typescript
let cachedKey: CryptoKey | null = null

async function getKey(): Promise<CryptoKey> {
	if (cachedKey === null) {
		cachedKey = await crypto.subtle.generateKey({ hash: "SHA-256", name: "HMAC" }, false, [
			"sign",
			"verify",
		])
	}
	return cachedKey
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const key = await getKey()
	const enc = new TextEncoder()
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(a))
	return crypto.subtle.verify("HMAC", key, sig, enc.encode(b))
}
```

### Tests

**Internal:**

- Equal strings → true
- Different strings → false
- Different lengths → false
- Empty strings → true
- Unicode strings work correctly

**Consumer:**

- API key comparison: valid key → allowed, invalid key → denied
- Timing: equal and unequal comparisons take similar time (statistical test — 100 iterations, stddev within threshold)

### Files

| File            | Change                             |
| --------------- | ---------------------------------- |
| `src/crypto.ts` | **NEW** — `timingSafeEqual`        |
| `package.json`  | Add `./crypto` export              |
| Tests           | `tests/unit/crypto/crypto.test.ts` |

---

## 3. Cookie Prefixes (`__Host-`, `__Secure-`)

### Why

Browser-enforced cookie security. `__Host-` tells the browser to reject the cookie unless `Secure`, `Path=/`, no `Domain`. `__Secure-` requires `Secure`. Hono enforces at serialization time. Honey doesn't — a developer could set `__Host-session` without `Secure` and the browser silently drops it.

### Design

Add validation in `serializeCookie`. Do NOT mutate the caller's `opts` — apply defaults internally:

```typescript
export function serializeCookie(name: string, opts: CookieOptions): string {
	let secure = opts.secure
	let path = opts.path

	if (name.startsWith("__Host-")) {
		if (!opts.secure) throw new Error("__Host- cookies require secure: true")
		if (opts.domain) throw new Error("__Host- cookies must not set domain")
		if (opts.path !== "/" && opts.path !== undefined)
			throw new Error("__Host- cookies must have path: '/'")
		secure = true
		path = path ?? "/"
	} else if (name.startsWith("__Secure-")) {
		if (!opts.secure) throw new Error("__Secure- cookies require secure: true")
		secure = true
	}

	/* use secure and path locals instead of opts.secure/opts.path below */
}
```

### Tests

**Internal:**

- `__Host-session` with `secure: true, path: "/"` → valid
- `__Host-session` without `secure` → throws
- `__Host-session` with `domain` set → throws
- `__Host-session` with `path: "/api"` → throws
- `__Host-session` with no path → auto-sets `"/"`
- `__Secure-token` with `secure: true` → valid
- `__Secure-token` without `secure` → throws
- Normal cookie name → no prefix validation

**Consumer:**

- Setting `__Host-` cookie with correct options → Set-Cookie header valid
- Setting `__Host-` cookie wrong → error at serialization, not silent browser rejection

### Files

| File              | Change                                 |
| ----------------- | -------------------------------------- |
| `src/response.ts` | Validate prefixes in `serializeCookie` |
| Tests             | `tests/unit/response/response.test.ts` |

---

## 4. IP Restriction Middleware

### Why

Admin panels, webhook endpoints, internal APIs need IP filtering. Without it, developers build ad-hoc solutions that miss edge cases (CIDR ranges, proxy headers).

### Design

```typescript
import { ipRestrict } from "@lovrozagar/honey/ip-restrict"

app.use(
	ipRestrict({
		allowList: ["192.168.1.0/24", "10.0.0.1"],
		getIp: (req) => req.headers.get("cf-connecting-ip"),
	}),
)
```

```typescript
type IpRestrictOptions = {
	allowList?: string[] /* exact IPs or CIDR ranges */
	denyList?: string[] /* checked first — deny wins over allow */
	getIp?: (req: Request) => string | null
}
```

IP extraction defaults:

1. `CF-Connecting-IP` (Cloudflare)
2. `X-Forwarded-For` (first entry)
3. `X-Real-IP`
4. Falls back to `null` (deny when null + allowList set)

CIDR matching: IPv4 only initially. Parse `192.168.1.0/24` into base + mask, compare via bitwise AND. IPv6: exact match only (full CIDR would require 128-bit math).

### Tests

**Internal:**

- IP in allowList → allowed
- IP not in allowList → 403
- IP in denyList → 403 (even if also in allowList)
- CIDR range: `10.0.0.50` matches `10.0.0.0/24`
- CIDR range: `10.0.1.50` does NOT match `10.0.0.0/24`
- Custom `getIp` function used
- No IP extracted (null) with allowList → 403
- No IP extracted (null) with no allowList → allowed
- Exact IPv6 match works
- `/32` CIDR = exact match

**Consumer:**

- Admin route with IP restriction → allowed from office IP, blocked from public
- Webhook endpoint with Stripe IP range → only Stripe IPs accepted

### Files

| File                 | Change                                      |
| -------------------- | ------------------------------------------- |
| `src/ip-restrict.ts` | **NEW** — middleware + CIDR matcher         |
| `package.json`       | Add `./ip-restrict` export                  |
| Tests                | `tests/unit/middleware/ip-restrict.test.ts` |
