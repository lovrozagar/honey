# JWT

`@lovrozagar/honey/jwt` signs and verifies compact JWS tokens on WebCrypto, so the same code runs on Node, Bun and
Workers with no JWT library. It is functions, not middleware: your app decides where a token comes from and what a
refusal answers.

## Example

```ts run
import { signJwt, verifyJwt } from "@lovrozagar/honey/jwt"

const secret = "a-secret-of-at-least-32-bytes-long"
const exp = Math.floor(Date.now() / 1000) + 3600

const token = await signJwt({ exp, iss: "auth", sub: "user-1" }, { alg: "HS256", key: secret })
const result = await verifyJwt(token, { algorithms: ["HS256"], issuer: "auth", secret })

console.log(result.success)
// prints: true
```

## Typed claims

Pass a Standard Schema (zod, valibot, arktype) as `schema` and the payload is its output. Claims it refuses answer
`invalid_claims`. It reads only a token whose signature and claim rules already passed, so a forged token never
reaches it.

```ts run
import { signJwt, verifyJwt } from "@lovrozagar/honey/jwt"
import * as z from "zod"

const secret = "a-secret-of-at-least-32-bytes-long"
const exp = Math.floor(Date.now() / 1000) + 3600
const claims = z.object({ role: z.enum(["admin", "member"]), sub: z.string() })

const token = await signJwt({ exp, role: "admin", sub: "user-1" }, { alg: "HS256", key: secret })
const result = await verifyJwt(token, { algorithms: ["HS256"], schema: claims, secret })

if (result.success) console.log(result.payload.role)
// prints: admin
```

## An issuer's public keys

Create one `remoteJwks` per issuer, once, and pass it to every verify. Its cache lives in the source it returns.

```ts
import { remoteJwks, verifyJwt } from "@lovrozagar/honey/jwt"

declare const clientId: string
declare const token: string

const apple = remoteJwks("https://appleid.apple.com/auth/keys")

const result = await verifyJwt(token, {
	algorithms: ["RS256"],
	audience: clientId,
	issuer: "https://appleid.apple.com",
	jwks: apple,
})
```

`audience` and `issuer` are required with `jwks`. An issuer's keys sign every token it gives any app, so only those
two say a token is for yours.

## Reference

| Value                                 | What it does                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `signJwt(payload, { alg, key, kid })` | signs with an HMAC secret or a private `CryptoKey`; set `exp` yourself                                                    |
| `verifyJwt(token, options)`           | checks the signature, then the claims, then `schema` if given, and answers `{ success, payload }` or `{ success, error }` |
| `remoteJwks(url, options?)`           | an issuer's keys, kept 10 minutes; concurrent lookups share one fetch                                                     |
| `decodeJwtPayload(token)`             | the claims, unverified; never authorize on this                                                                           |
| `importPkcs8(pem, alg)`               | a private signing key from a PKCS#8 PEM                                                                                   |
| `isJwsAlgorithm(value)`               | whether honey supports that `alg`                                                                                         |

`verifyJwt` also takes `clockToleranceSeconds` for skew on the time claims, `maxAgeSeconds` to refuse an older token,
and `requiredClaims` for claims a token must carry beyond `exp`.

`verifyJwt` takes exactly one of `secret`, `jwk` or `jwks`, so a token cannot choose which kind of key verifies it. It
requires `exp` unless you pass `requireExp: false`.

Algorithms: `HS256`, `HS384`, `HS512`, `RS256`, `RS384`, `RS512`, `PS256`, `PS384`, `PS512`, `ES256`, `ES384`, `ES512`
and `EdDSA`. `none` is refused, and so is any header with `crit`.

## Refusals and outages

| `error`             | Meaning                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| `malformed`         | not a token, an algorithm you did not accept, or `crit`                      |
| `invalid_signature` | the signature does not match this key                                        |
| `expired`           | past `exp`, or older than `maxAgeSeconds`                                    |
| `invalid_claims`    | wrong issuer or audience, a missing or bad claim, or claims `schema` refuses |
| `unknown_key`       | the issuer has no key for this token                                         |

Every refusal is a result. `verifyJwt` throws only for what the token did not cause: no secret configured, or a `jwks`
lookup that cannot reach the issuer and holds no usable keys. Answer a refusal with 401 and let a throw be a 5xx.

When the issuer cannot be reached, keys already held keep verifying for `staleMs` (1 hour) past `maxAgeMs` (10 minutes).
A failed fetch or an unknown `kid` fetches again at most once per `cooldownMs` (30 seconds), so a stream of forged ids
cannot hammer the endpoint. One fetch waits at most `timeoutMs` (5 seconds).
