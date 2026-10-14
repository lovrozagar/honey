# dx — cookies

`ctx.cookies` get/set, and signed cookies. KEEP (bit 02 `context/{cookie,cookie-sign}.ts`).

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `ctx.cookies.get(name)` | — | — | read a request cookie | missing → `undefined` | `context/cookie.test.ts` |
| `ctx.cookies.set(name, value, opts?)` | — | — | set a response cookie; `opts`: `path`, `domain`, `maxAge`, `expires`, `httpOnly`, `secure`, `sameSite` | `secure`+`sameSite` default to safe values; setting a cookie disables `compress` on that response (BREACH, H18.7) | `context/cookie.test.ts` |
| signed cookies (`cookie-sign`) | — | — | HMAC-sign a cookie value; verify is **constant-time**. `createCookieSigner(secrets)` → `{ sign, verify }` imports each key **once per instance** (H19.3: instance, not module scope) — the hot-path API; standalone `sign`/`verify` keep their v0 shape and re-import per call (the one-off path) | tamper → treated as absent, not thrown; key rotation via a key list (first signs, any verifies); a per-request verify must use the signer, not standalone `verify` (re-importing the HMAC key per call is +2µs Bun / +6µs Node). No app-level cookie secret exists — the app/user holds the signer | `context/cookie-sign.test.ts` |
| cookie codec | — | — | parse/serialize per RFC 6265 | malformed attributes rejected; no injection into `Set-Cookie` (fuzz corpus) | `context/cookie.test.ts` |
