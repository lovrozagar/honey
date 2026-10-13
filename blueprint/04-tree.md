# 04 — Tree

What each directory is for, in both packages. The exhaustive, normative file list is `files.tsv`; this file explains the shape. v1 groups v0's flat 124-file `src/` (and the codegen half that moves to `packages/gen`) into responsibility folders under the limits.

## `packages/core` — `@lovrozagar/honey`

```
packages/core/
  src/
    routing/        route model, pattern, tree, request-path, finalize, dispatch (splits v0 index.ts 3,829 + tree.ts 558)
    context/        HoneyContext, ctx builders, cookies, cookie-sign
    input/          input, params, query, headers, json, form, binary (A1); body-limit/kind, accepts
    validation/     validate-input, validate-output, content-type (the standard-schema runners)
    response/       response, builder (ex honey-response), media-type, binary (A1), sse, range (A3), etag + last-modified (A4), cache-control (A4), with-headers, response-headers (A2), static
    errors/         error, errors, defineErrors, projector, problem+json (A7), on-error (the awaited response-shaping app.onError — H17)
    middleware/     middleware core; cors, secure-headers, csrf, rate-limit (A5), compress (A6), request-id, timeout, server-timing, powered-by, ip-restrict
    streaming/      producer-stream
    realtime/       bus, route, server, register, reference-server (H8)
    ws/             node, bun, cloudflare, session, shared, origin (deno deleted — H15)
    openapi/        collect, generate, manifest, extract-schemas, document, paths, components, security, servers (B1), tags (B2), webhooks (B3), spec-factory, spec, scalar, swagger, docs-page, serve, json-schema-slot, register
    schema/         standard-schema → JSON Schema (zod/valibot/arktype/yup/effect), slots/hoist/dedup, canonicalize, resolve-refs, sanitize-spec (split from v0 codegen.ts)
    meta/           meta-spec, meta-spec-merge, meta-spec-validate
    trust/          trust (+ ctx.trustsForwarded seam), ip, client-info
    security/       crypto
    i18n/           i18n, slot, dict
    observability/  curl-logger, request-to-curl
    adapters/
      node/         serve, request (node:* allowed)
      bun/          bun serve (Bun allowed)
      workers/      cf serve (Workers runtime)
    runtime/        detect-runtime, feature-detect/load/slots, peer (deno branches removed)
    telemetry/      logger (the only console owner; ex "./logger"), request-log, otel, traceparent, span-lifecycle, fields
    build/          plugin, loaders, cli, cli-args, glob, yaml, targets, index
    testing/        the testing helper
  tests/
    integration/    feature-named suites (auth, routing, middleware, streaming, cookies, cors, errors, proxy, static, realtime, validation, i18n, telemetry, trust, …)
    e2e/
      apps/         compose, defaults, gateway, kitchen, surface
      run.ts        the 30-cell runner; differential.ts; builds.ts; load.ts
    types/          type-level tests
    regression/     frozen 313-finding guard (names stable for regression-matrix traceability)
```

Every `src/**` leaf has a colocated `*.test.ts`. A folder's `index.ts` is `kind=index` (re-export only) and has no sibling test. There is **no `exports/` folder**: each `package.json` subpath maps straight to its module file (e.g. `./accepts` → `src/input/accepts.ts`, `./logger` → `src/telemetry/logger.ts`, `./openapi` → `src/openapi/register.ts`), or to that folder's `index.ts` (`kind=index`) when a subpath publishes several files. The subpath→file map lives in `package.json`, not a code folder.

## `packages/gen` — `@lovrozagar/honey-codegen`

```
packages/gen/
  src/
    ir/             IR builder + model (moved codegen-ir, codegen-sdk-model, codegen-schema-naming, codegen-route-tree-intern)
    emit/
      shared/       codegen-lang sanitizer, codegen-sanitize, codegen-hash, the formatter post-pass (one shared fuzzed string-escape layer — F2)
      ts/           TypeScript SDK (moved client/, ts-type-emitter) — overrides (C2)
      go/            Go SDK (moved client-go/, codegen-go, go-type-emitter) + gofmt
      rust/          Rust SDK (moved client-rust/, codegen-rust, rust-type-emitter) + rustfmt
      python/        Python SDK (moved client-python/, codegen-python, python-type-emitter) + ruff/black
      csharp/        C#/.NET SDK (new — H11): HttpClient + System.Text.Json, .csproj, net8→net10
      java/          Java SDK (new — H11): HttpClient + Jackson, Gradle, --release 17
      cli/           Go CLI (moved cli-go/, codegen-go-cli) — cf-grade (E1)
      mcp/           MCP server (moved client-mcp/, codegen-mcp) — structured output + annotations (D1)
    extract/        type-extractor split: extract, walk, serialize, chain (ts-morph compiler API — H12; optional peer)
    runtime/        vendored runtime templates per language (H9)
    cli.ts          the honey-codegen generate CLI; gen/process.ts + gen/write.ts orchestrate
  tests/
    integration/    harness per language (ts/go/rust/python/csharp/java/mcp/cli), polyglot compile/runtime/conformance
    fixtures/       adversarial specs, schema-naming corpora
```

Each `gen` subpath maps straight to its module file (no `exports/` folder). The IR is the only thing `gen` reads from `core`'s output. No `gen` file imports `@lovrozagar/honey` internals. `emit/ts/` also holds `realtime.ts` (the resume client) and `type-gen.ts` (JSON Schema → TS), and `emit/shared/` holds `webhooks.ts` (B3).

## `_v0` (during the rewrite)

v0 is parked at **`packages/core/_v0/{src,tests}`** (one `git mv` of src+tests, preserving all relative test imports) and stays there until bit 20 deletes it (H21). Every `package.json` subpath points into `_v0/src` at bit 00; each flips to its v1 module in the bit that completes it (`.` at end of bit 08; codegen/client/cli subpaths in bits 09–18). `_v0/**` is outside every `src/**` glob (coverage, tree-as-source, the `honey/*` lint rules) and the published `files`, so v0's console calls and module state don't trip v1's gates.

## Line-budget note

Every v0 file over 300 lines (24 of them, led by `codegen.ts` 5,089, `index.ts` 3,829) is split across the folder it moves into; no v1 file exceeds the `00-rules.md` limits. `files.tsv` carries a per-row budget flag.
