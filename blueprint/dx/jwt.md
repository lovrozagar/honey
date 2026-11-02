# dx — jwt

Compact JWS tokens on WebCrypto, so Node, Bun and Workers need no JWT library. Functions, not middleware: the app owns where a token comes from and what a refusal answers. No module state.

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `signJwt(payload, { alg, key, kid })` | `alg`, `key` | no `kid` | a compact JWS | set `exp` yourself: `verifyJwt` refuses a token without one | `security/jwt.test.ts` |
| `verifyJwt(token, options)` | `algorithms`, one of `secret`, `jwk`, `jwks` | — | the claims, or why the token was refused | it throws only for no secret or an unreachable issuer with no usable keys | `security/jwt.test.ts` |
| `audience`, `issuer` | with `jwks` | not checked | a token must carry an accepted value | an issuer's keys sign every app's tokens, so `jwks` requires both | `security/jwt.test.ts` |
| `clockToleranceSeconds` | no | `0` | skew allowed on the time claims | — | `security/jwt.test.ts` |
| `maxAgeSeconds` | no | none | refuses a token older than this, and requires `iat` | — | `security/jwt.test.ts` |
| `requiredClaims` | no | `[]` | claims a token must carry, beyond `exp` | — | `security/jwt.test.ts` |
| `requireExp` | no | `true` | `false` accepts a token with no `exp` | that token never expires | `integration/security/jwt-adversarial.test.ts` |
| `remoteJwks(url, options?)` | `url` | — | an issuer's keys; concurrent lookups share one fetch | its state lives in the source: create one per issuer, once | `security/jwks.test.ts` |
| `maxAgeMs` | no | 10 minutes | how long keys are used before a fetch | — | `security/jwks.test.ts` |
| `cooldownMs` | no | 30 seconds | the least time between fetches a failure or an unknown `kid` causes | a key published inside the cooldown is `unknown_key` until it ends | `security/jwks.test.ts` |
| `staleMs` | no | 1 hour | how far past `maxAgeMs` keys verify through an outage | — | `security/jwks.test.ts` |
| `timeoutMs` | no | 5 seconds | how long one fetch may take | — | `security/jwks.test.ts` |
| `decodeJwtPayload(token)` | `token` | — | the claims, unverified, or `null` | never authorize on this | `security/jwt.test.ts` |
| `importPkcs8(pem, alg)` | both | — | a private signing `CryptoKey` | — | `security/jwt.test.ts` |
| `isJwsAlgorithm(value)` | `value` | — | whether honey supports that `alg` | — | `security/jwt.test.ts` |
