# dx — crypto

WebCrypto-based helpers used by cookie signing and anywhere an app needs a safe primitive. KEEP (bit 07 `security/crypto.ts`). Portable (`crypto.subtle`, no `node:crypto`).

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| HMAC sign / verify | — | — | sign + **constant-time** verify (the cookie-sign + webhook-verify primitive) | verify must use a timing-safe compare, never `===` on the digest | `security/crypto.test.ts` |
| random id / token | — | — | `crypto.randomUUID()` / random bytes | never `Math.random` for anything security-relevant | `security/crypto.test.ts` |
| base64url encode/decode | — | — | url-safe encoding for signed values | reject malformed input rather than throw | `security/crypto.test.ts` |
| runtime | — | WebCrypto | works on node/bun/cf without `node:crypto` | — | `security/crypto.test.ts` |
