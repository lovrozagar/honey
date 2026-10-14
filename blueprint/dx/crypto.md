# dx — crypto

WebCrypto-based helpers used by cookie signing and anywhere an app needs a safe primitive. KEEP (bit 07 `security/crypto.ts`). Portable (`crypto.subtle`, no `node:crypto`).

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `timingSafeEqual(a, b)` | — | — | the one exported helper (v0 had only this): HMACs both sides under a **fresh random key per call** (no module state, H23) and compares via `subtle.verify`, so neither content nor length leaks; strings compare by UTF-16 code unit (lone surrogates don't collapse), a string never equals bytes | never `===` on a digest; timing itself isn't deterministically testable, so the guard pins the surrogate property (a UTF-8-bytes compare equates two different lone surrogates) | `security/crypto.test.ts` |
| runtime | — | WebCrypto | works on node/bun/cf without `node:crypto` | — | `security/crypto.test.ts` |
