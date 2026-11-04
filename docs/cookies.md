# Cookies

`ctx.cookies[name]` reads a request cookie: `ctx.cookies` is the request's cookies, parsed once. A response
sets cookies through its `cookies` option, one `Set-Cookie` each, with `path`, `domain`, `maxAge`, `expires`,
`httpOnly`, `secure` and `sameSite`. `createCookieSigner({ name, secrets })` from
`@lovrozagar/honey/cookie-sign` signs one cookie's values with HMAC, the cookie's name bound into each signature,
and verifies them in constant time; pass several secrets to rotate one in without logging everyone out. The codec parses and serializes per RFC 6265.

## Example

```ts
import { honey } from "@lovrozagar/honey"
import { createCookieSigner } from "@lovrozagar/honey/cookie-sign"

const signer = createCookieSigner({ name: "session", secrets: [process.env.COOKIE_SECRET ?? ""] })

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

| Value                          | Default | What it does                                                                                                                                                                                        | Watch for                                                                                                                                                                                                                                          |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.cookies[name]`            | —       | read a request cookie: `ctx.cookies` is the request's cookies, parsed once                                                                                                                          | missing → `undefined`                                                                                                                                                                                                                              |
| `cookies` response option      | —       | set response cookies: `ctx.res.json(status, body, { cookies: { [name]: { value, path, domain, maxAge, expires, httpOnly, secure, sameSite } } })`, one `Set-Cookie` each                            | `secure`+`sameSite` default to safe values; setting a cookie disables `compress` on that response (BREACH, H18.7)                                                                                                                                  |
| signed cookies (`cookie-sign`) | —       | HMAC-sign one cookie's values; verify is **constant-time**. `createCookieSigner({ name, secrets })` → `{ sign, verify }` binds `name` into every signature and imports each key **once per signer** | tamper → treated as absent, not thrown; key rotation via a key list (first signs, any verifies); a value signed for another cookie, or in the unbound v1 format, never verifies. No app-level cookie secret exists — the app/user holds the signer |
| cookie codec                   | —       | parse/serialize per RFC 6265                                                                                                                                                                        | malformed attributes rejected; no injection into `Set-Cookie` (fuzz corpus)                                                                                                                                                                        |
