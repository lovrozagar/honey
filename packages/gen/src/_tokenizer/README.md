# Vendored o200k_base tokenizer

The token-budget gate (00-rules "Token budget gate", H6) counts tokens with a pinned tokenizer so a
count is the same on every machine. This folder is that pin: the `o200k_base` encoding and the
modules it imports, copied verbatim from the published ESM build. Nothing here is edited; replace
the folder from a new tarball to move the pin, and record the new version below.

| field | value |
| --- | --- |
| package | `gpt-tokenizer` (MIT, see `LICENSE`) |
| version | 4.0.0 |
| npm integrity | `sha512-YAWIyzvuVUHEfW7tFfFAxH8qQb+Q3RU9nYOTy7skMNX5qzU6Q8jxTHZLyO56ug1vYvCR7wndzpd3jwD86/mhjQ==` |
| npm shasum | `5443ee8522bb87c1ab1877c029efe4ba9e912b32` |
| copied | `esm/encoding/o200k_base.js` and its import closure (`.js` + `.d.ts`), 2026-10-14 |

Entry: `encoding/o200k_base.js` (`countTokens`, `encode`, `decode`). Lint, format and coverage
skip this folder; it is third-party code kept byte-identical to the tarball.
