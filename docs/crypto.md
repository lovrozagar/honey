# Crypto

`timingSafeEqual(a, b)` from `@lovrozagar/honey/crypto` compares two secrets without leaking where they
differ: it HMACs both sides under a fresh random key and compares the digests. It runs on WebCrypto, so the same
code works on Node, Bun and Workers without `node:crypto`.

## Example

```ts run
import { timingSafeEqual } from "@lovrozagar/honey/crypto"

const expected = "s3cret-token"
console.log(await timingSafeEqual("s3cret-token", expected), await timingSafeEqual("guess", expected))
// prints: true false
```

## Reference

| Value                   | Default   | What it does                                                                                                                                                                                                                                                                                       | Watch for                                                                                                                                                                       |
| ----------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timingSafeEqual(a, b)` | —         | the one exported helper (v0 had only this): HMACs both sides under a **fresh random key per call** (no module state, H23) and compares via `subtle.verify`, so neither content nor length leaks; strings compare by UTF-16 code unit (lone surrogates don't collapse), a string never equals bytes | never `===` on a digest; timing itself isn't deterministically testable, so the guard pins the surrogate property (a UTF-8-bytes compare equates two different lone surrogates) |
| runtime                 | WebCrypto | works on node/bun/cf without `node:crypto`                                                                                                                                                                                                                                                         | —                                                                                                                                                                               |
