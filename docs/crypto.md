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

## Signing a webhook

`signWebhook({ id, timestamp, body, secrets })` from `@lovrozagar/honey/webhook` answers the three
[Standard Webhooks](https://www.standardwebhooks.com) headers for one delivery, so a receiver verifies with any library
for that scheme. For the events your API declares, `webhookContract` builds the body and signs each attempt through
it: see [webhooks](capabilities/webhooks.md).

```ts
import { signWebhook } from "@lovrozagar/honey/webhook"

const body = JSON.stringify({ type: "invoice.paid" })
const headers = await signWebhook({
	body,
	id: "msg_1",
	secrets: "whsec_a2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2s=",
	timestamp: Math.floor(Date.now() / 1000),
})

await fetch("https://example.com/hook", { body, headers, method: "POST" })
```

Keep `id` across retries and give each attempt its own `timestamp`. During a rotation pass both secrets in a list:
each signs, and either verifies alone. A secret is base64 with an optional `whsec_` prefix, 24 to 64 bytes decoded.

## Reference

| Value                     | Default   | What it does                                                                                                                                                                                                                                                                                       | Watch for                                                                                                                                                                       |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timingSafeEqual(a, b)`   | —         | the one exported helper (v0 had only this): HMACs both sides under a **fresh random key per call** (no module state, H23) and compares via `subtle.verify`, so neither content nor length leaks; strings compare by UTF-16 code unit (lone surrogates don't collapse), a string never equals bytes | never `===` on a digest; timing itself isn't deterministically testable, so the guard pins the surrogate property (a UTF-8-bytes compare equates two different lone surrogates) |
| `webhookContract(events)` | —         | the events an API sends; `sign(type, data, { id, occurredAt, secrets })` answers one attempt's JSON body and headers, and `generateOpenApi` documents each event from it                                                                                                                           | `data` is the schema's output and no schema runs; keep `id` and `occurredAt` across retries                                                                                     |
| `signWebhook(options)`    | —         | the headers of a signed delivery; bad input is a `TypeError`, never a header that cannot verify                                                                                                                                                                                                    |
| runtime                   | WebCrypto | works on node/bun/cf without `node:crypto`                                                                                                                                                                                                                                                         | —                                                                                                                                                                               |
