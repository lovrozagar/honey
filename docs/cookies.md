# Cookies

`ctx.cookies[name]` reads a request cookie: `ctx.cookies` is the request's cookies, parsed once. A response
sets cookies through its `cookies` option, one `Set-Cookie` each, with `path`, `domain`, `maxAge`, `expires`,
`httpOnly`, `secure` and `sameSite`. `createCookieSigner` from
`@lovrozagar/honey/cookie-sign` signs a value with HMAC and verifies it in constant time; pass several secrets to
rotate one in without logging everyone out. The codec parses and serializes per RFC 6265.

## Example

```ts
import { honey } from "@lovrozagar/honey"
import { createCookieSigner } from "@lovrozagar/honey/cookie-sign"

const signer = createCookieSigner([process.env.COOKIE_SECRET ?? ""])

const app = honey()

app.post("/login").handler(async (ctx) => {
	const session = await signer.sign("user-1")
	const cookie = { value: session, httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" }
	return ctx.res.json("ok", { signedIn: true }, { cookies: { session: cookie } })
})

app.get("/me").handler(async (ctx) => {
	const raw = ctx.cookies.session
	const user = raw === undefined ? null : await signer.verify(raw)
	return ctx.res.json("ok", { user })
})
```

## Reference

| Value                          | Default | What it does                                                                                                                                                                                                                                                  | Watch for                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.cookies[name]`            | —       | read a request cookie: `ctx.cookies` is the request's cookies, parsed once                                                                                                                                                                                    | missing → `undefined`                                                                                                                                                                                                                                                                              |
| `cookies` response option      | —       | set response cookies: `ctx.res.json(status, body, { cookies: { [name]: { value, path, domain, maxAge, expires, httpOnly, secure, sameSite } } })`, one `Set-Cookie` each                                                                                      | `secure`+`sameSite` default to safe values; setting a cookie disables `compress` on that response (BREACH, H18.7)                                                                                                                                                                                  |
| signed cookies (`cookie-sign`) | —       | HMAC-sign a cookie value; verify is **constant-time**. `createCookieSigner(secrets)` → `{ sign, verify }` imports each key **once per instance** — the hot-path API; standalone `sign`/`verify` keep their v0 shape and re-import per call (the one-off path) | tamper → treated as absent, not thrown; key rotation via a key list (first signs, any verifies); a per-request verify must use the signer, not standalone `verify` (re-importing the HMAC key per call is +2µs Bun / +6µs Node). No app-level cookie secret exists — the app/user holds the signer |
| cookie codec                   | —       | parse/serialize per RFC 6265                                                                                                                                                                                                                                  | malformed attributes rejected; no injection into `Set-Cookie` (fuzz corpus)                                                                                                                                                                                                                        |
