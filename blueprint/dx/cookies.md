# dx — cookies

`ctx.cookies` (the request's, parsed), the `cookies` response option, and signed cookies. KEEP (bit 02 `context/{cookie,cookie-sign}.ts`).

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `ctx.cookies[name]` | — | — | read a request cookie: `ctx.cookies` is the request's cookies, parsed once | missing → `undefined` | `context/cookie.test.ts` |
| `cookies` response option | — | — | set response cookies: `ctx.res.json(status, body, { cookies: { [name]: { value, path, domain, maxAge, expires, httpOnly, secure, sameSite } } })`, one `Set-Cookie` each | `secure`+`sameSite` default to safe values; setting a cookie disables `compress` on that response (BREACH, H18.7) | `context/cookie.test.ts` |
| signed cookies (`cookie-sign`) | — | — | HMAC-sign one cookie's values; verify is **constant-time**. `createCookieSigner({ name, secrets })` → `{ sign, verify }` binds `name` into every signature and imports each key **once per signer** (H19.3: instance, not module scope); the standalone `sign`/`verify` and the unbound v1 format are gone (plan 39 6.7) | tamper → treated as absent, not thrown; key rotation via a key list (first signs, any verifies); a value signed for another cookie never verifies. No app-level cookie secret exists — the app/user holds the signer | `context/cookie-sign.test.ts` |
| cookie codec | — | — | parse/serialize per RFC 6265 | malformed attributes rejected; no injection into `Set-Cookie` (fuzz corpus) | `context/cookie.test.ts` |
