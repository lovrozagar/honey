# SDK runtime conformance vectors

Language-neutral JSON vectors for the SDK runtimes. Every runtime (TypeScript `client/*`,
the generated TypeScript SDK, Go, Rust, Python) should run them.

- `vectors/url-building.json` — base path and query preservation, path param encoding and
  validation (`""`, `.`, `..` rejected), template spellings, query serialization.
- `vectors/sse.json` — the WHATWG event-stream parser: line endings, sticky `id`, `retry`,
  BOM, U+2028, truncated final events, UTF-8 split across chunks. A chunk is a string (sent
  as UTF-8) or `{ "bytes": [...] }`.

`url-building.test.ts` and `sse.test.ts` run them against `client/*`.
