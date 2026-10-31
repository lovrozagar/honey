# Bit 21 — MCP files and remote MCP

Closes: the bit 18 carry-ins deferred at bit 19 (Streamable HTTP; multipart operations as tools), superseded by H24.
Oracle kept green: the MCP conformance grid (stdio), `sdk-budget.mcp.test.ts`, `tests/security/emit-adversarial.mcp.test.ts`.
Spec target: MCP **2026-07-28** (stateless) and the legacy era 2025-11-25 … 2025-03-26, served dual-era (H24).

## Scope
- **Files:** an `x-mcp` operation with a multipart body becomes a tool. A file part is a file argument: inline base64 under a cap, a `{path}` the stdio server reads inside a hard root, or (over HTTP) an upload reference or an opt-in allowlisted https URL.
- **Remote:** Streamable HTTP, served either:
  - standalone by the generated MCP package (`--http`, 127.0.0.1 by default, token required), or
  - mounted in the app itself through `mcp(app, path, handler, options?)` from `@lovrozagar/honey/mcp`. Tool calls dispatch in-process through `app.fetch`, so the app's middleware, limits and per-route auth apply. When the app has auth, the endpoint refuses an unauthenticated request before any dispatch.
- **Auth:** the app's credential carried as a header (the default), or an opt-in OAuth 2.1 resource-server role (RFC 9728 protected-resource metadata, 401/403 challenges). honey never ships an authorization server.
- **The protocol:** one vendored, dependency-free runtime (H9), transport-agnostic and dual-era, under the stdio and HTTP transports. Stateless in both eras: no session id is ever minted.
- **Acceptance:** an Anyrow-shaped fixture with the five public multipart operations (extract ×2, extract-stream ×2 as a bounded SSE collect, suggest-schema; an `ApiKey` header scheme), driven by the official clients over stdio, standalone HTTP and the mounted endpoint (bun, node and Workers).

## Phases
| phase | content |
|---|---|
| a | this record: H24, the bit file, the `./mcp` surface row |
| b | dual-era protocol; the runtime split into `protocol` + `stdio`; modern 2026-07-28 over stdio; client pins add TS `@modelcontextprotocol/client` 2.4.0 and Python `mcp` 2.3.0 |
| c | files over stdio: multipart → tools, inline + path, the hard FILE_ROOT, caps; the provisional extension's wire shape behind one module; Anyrow-shaped acceptance over stdio |
| d | the HTTP transport + standalone `--http`: method table, headers, Origin/Host, token, JSON/SSE, cancel-on-close; batches only under 2025-03-26 |
| e | mounted: the plugin's `mcp` output (`_gen/mcp.gen.ts`), `@lovrozagar/honey/mcp`, in-process dispatch, credential forwarding, auth-before-dispatch, 401/403 → HTTP challenges; e2e bun/node/cf cells |
| f | opt-in OAuth resource server: PRM, challenges, the resource check; TS v2 client authProvider legs against a stub AS |
| g | remote files: the extension's upload flow (one-shot, scoped, expiring HMAC tokens; app-supplied `UploadStore` with an atomic claim) and the opt-in URL fetch |
| h | corpus completion, LACKS re-justified, docs, the budget close, the live Cloudflare leg (honey-63 runs it, as j3) |
| i | (only if the user rules R11 in) the SDK safe API redesign |

## Tests (named, written first)
- The `mcp` conformance target's `http` variant, run against standalone and mounted; legacy (TS sdk 1.32.2) and modern (TS client 2.4.0 pinned to 2026-07-28, Python mcp 2.3.0) clients over both transports.
- New MCP-only rows: file-inline, file-path (stdio), file-path-refused (http), origin-403, method-405, accept-406, header-mismatch-400, batch-by-era, auth-before-dispatch (an unauthenticated tools/list is refused on an authed app), auth-401-challenge, upload-one-shot, url-fetch-allowlist.
- A structure leg: no file but the extension module names `x-mcp-file`.
- A runtime-bundle leg: an app that imports nothing from `./mcp` bundles no MCP module.

## Security corpus
Every leg is red first:
- **Headers:** version/`_meta` mismatch; missing or mismatched `Mcp-Method`/`Mcp-Name`; non-ASCII encoded names; unsupported versions.
- **Origin** (`null`, case, ports, trailing dot, userinfo, IDN, scheme, duplicates) and **Host** (rebinding names, IPv6, ports).
- **Body:** size; nesting; batches per era; a POSTed JSON-RPC response; prototype keys.
- **Paths:** `..`, absolute outside, symlink and symlink chain escapes, the check-then-swap race (dev/ino), devices, FIFO, socket, directory, `/proc/self/*`, encoded and NUL bytes, growth past the cap.
- **Inline:** size vs declared, padding, whitespace, data-URI prefix, digest, cap ±1.
- **Uploads:** replay, expiry, scope swap (tool, args, principal), size/digest on PUT, foreign secret, PUT without a call.
- **URL fetch:**
  - hosts off the allowlist; no wildcard unless listed;
  - non-https;
  - a redirect off the allowlist;
  - a body past the cap with a lying Content-Length (the cap is streamed);
  - a timeout;
  - private, loopback, mapped and decimal/octal IP literals.
- **Auth:** an inner 401 surfaces as HTTP 401 with a challenge; credentials are scrubbed from results, errors and logs on every transport.

## Budget
- **Runtime bytes:** the MCP runtime lock is 31,165 B at zero headroom (`sdk-budget.mcp.test.ts:77`). Each phase names its added bytes per feature, with dead code cut first.
- **Tokens:** the per-app MCP ceilings move only by named tokens (the file tools of `surface` `POST /in/file` and the reference app's new routes); H6's per-tool ~400 holds.

## Tracked: the provisional file-uploads extension
The file argument's wire shape follows `io.modelcontextprotocol/files`. That is a draft extension in an open PR, https://github.com/modelcontextprotocol/experimental-ext-file-uploads/pull/1, pinned at head `6101d34eb52b21d4b87028543ecd1fd59ed3d5df`. It may change, its identifier included.
- **One module** owns that shape, and a structure leg holds that no other file names `x-mcp-file`.
- **Re-checked at every phase start and at the close:** a change in the PR is a one-module diff plus its legs.
- **No shipping client implements it yet;** the legs use a minimal extension client of our own.

## Recorded during the bit
- **Host refusal is 421** (Misdirected Request, RFC 9110 §15.5.20) where the TypeScript MCP SDK answers 403. A request for a host the server is not is misdirected, not forbidden.
- **`ctx.res.json(key)` has no runtime check** of a `.output()` key. The types are the contract. `assertOutputKeys` runs only where the document and route tree are generated, so the minimal bundle stays under its 26,200 B lock. A decided limit.
- **An upload store's claim lives in D1 or a Durable Object, its bytes in R2.** D1 rows and SQLite Durable Object values cap near 2 MB, while uploads default to 50 MiB. The plan's "D1 or DO" for the whole store was wrong; the docs and `UploadStore`'s comment say so.
- **A honey-built Worker passes its entry's named exports on** (h), so the Durable Object an upload store needs can be exported. Without it the production setup the docs recommend could not be built. `default` stays honey's fetch; a second default is refused. workerd refuses a module whose named export is a string, number, boolean or null, and one such export stops the whole Worker. The plugin sees names, not values, so such a value passes on as an inert empty object (9f5f413, found by a leg that loads a plain-value entry in workerd).
- **Deleting a Worker by name removes its own Durable Object namespaces.** A probe on the owner's account (wrangler 4.110, `wrangler delete --name`, no `--force`) left the account's namespace ids exactly as before. The live MCP leg relies on this, and its teardown asserts it rather than deleting a namespace itself.
- **The live leg's upload store is a Durable Object,** not memory: a memory store would make the leg's verdict depend on which isolate answered. `wrangler dev` runs one isolate, so cross-isolate one-shot is shown only live (`upload-raced`).
- **api-key-on-origin stays a LACKS row** with its exact reason (h); lifting it needs a change to the reference document, not to the emitters.
- **Every test or hook that spawns declares its bound** (`honey/spawn-timeout`): three spawning legs passed locally and timed out under vitest's defaults on slow CI runners. Core and gen each hold `SPAWN_TIMEOUT`, and a structure leg keeps the twins equal.
- **The live MCP leg ran on the owner's account at 51fe6c3** (2026-10-29): the mcp app's prod Worker as `honey-e2e-mcp` (no compatibility flags, its uploads in a `McpUploads` Durable Object), all 8 legs passed: unauthenticated 401, the five tools inline through SDK 1.32.2 at 2025-11-25, client 2.4.0 at 2026-07-28 and Python mcp 2.3.0, the inner 401, the upload by hand, eight racing PUTs (one 204, seven 409), and the files extension client. Torn down by exact name; the account's Durable Object namespace ids are exactly those before the deploy.
- **The Bun guard is DECIDED: none.** No local pin check and no second Bun in CI. Instead, the reviewer gate requires each manifest to quote Bun 1.3.11 and a whole `test:harness` run on both Buns (1.3.11 and 1.4.4). Revisit when CI's pin moves.
- **The e2e app-build gate's history:** it started at k=1 (425f0a4). Run 40877110861 went red on unchanged code from one slow sample. The gate moved to the median of three builds (1a41b73), judged only on GitHub Actions (bd13cba), went report-only during the re-record (16ea742), and was re-enforced from six k=3 records (b82ced6). Its first enforcing run, 40920311441, was green.
- **The bench gate had the same k=1 burst class:** the adapter bench went red on unchanged code (40913885826: stacked-json 2.36 > 2.354, where the same commit read 1.62 to 2.36). The k-pass slice fixes it by judging each scenario on the median of k interleaved pass medians.
- **Five drivers were hollow (found in i7b):** the five non-TS realtime test drivers dropped send errors, so their cells passed without proving anything. They now surface the error, and the over-cap send cell is aligned across all six SDKs.
- **The Java deadline race (536d8e7, landed as 530b637):** the e2e leg accepts either cause the design allows, and a deterministic leg pins each branch. No test seam ships.
- **TS SSE mid-drop raised a raw TypeError** from bit 20 until i0 (f7c1cd8), which breaks f2. It now takes f2's single no-answer path. It never shipped.
- **Phase i is done:** all six SDKs emit a normal client and a `safe` mirror. Per-op token ceilings: TS 98, Python 90, Go 137, Rust 95, C# 129, Java 113.
- **Owed before the 1.0 tag: the release notes.** CHANGELOG.md stops at 0.7.3 and has nothing for bits 1–21. A slice right after this close writes the full 0.7.3→1.0 entry (Breaking summarizes docs/migration.md, Added/Fixed from bits/01–21) and adds a check that refuses a version tag without its CHANGELOG entry (owner, 2026-10-29).
- **`node-version: current` ran a Node alpha (CI 40952484194, red).** On 2026-10-29 nodejs.org's index listed v27.0.0-alpha.0.0.0 above v26.13.0, and setup-node's `current` takes the top entry, so every "node current" job ran a prerelease published that same day. Its http.Server keepAliveTimeout default is 65000 (26 uses 5000), and serve.test.ts asserted 26's literal. Fixed twice over: the leg compares against a bare createServer() (253c576), and "current" now resolves to the newest non-prerelease. A blocking CI never runs prereleases.
- **The perf gates' ratios follow the runner's CPU model.** A ratio to a raw twin cancels runner speed, not microarchitecture. GitHub handed out at least five models (EPYC 7763, 9V45, 9V74; Xeon 8573C, 6973P-C), and 6-run ceilings redded unchanged code twice: cancel-release 7.27 on a 7763 (40989902937), and stream-1mb 2.08 (40991615047), an under-sampled tail. The k=3 bench re-record (cde0788) and the in-window e2e reference (bref: R B R B R B R per cell, plus 15,000 units of JS work, chosen over a bare reference by an H1 check on both from the same 12 records) came first. The owner then chose (2026-10-30) pooled ceilings under one rule for both baselines: max(worst × 1.1, exp(m + z·σ_upper)), with σ_upper as σ's one-sided 90% bound and z sized to a 2% per-run false-red budget. That gives bench.json 0.95% over 24 runs and build.json 1.91% over 12, with leave-one-out 1/24 (the stream-1mb outlier itself) and 0/12. Eleven bench scenarios name their per-model levels and a loose catch on the lowest. **Owed as the next bit:** a same-runner A/B gate (head vs a pinned base commit), which cancels the CPU model and ends re-records.
- **The live MCP leg ran again at the close, at 16e4d70** (2026-10-30), since MCP moved onto `client.safe` after the 51fe6c3 run: the same `honey-e2e-mcp` Worker and the same 8 legs, all passed. Torn down by exact name; the account's 9 Durable Object namespace ids are exactly those before the deploy.

## Shipped (the bit 21 close)

Closed at i7g; the closing CI run is this stack's push. Each phase landed red-first, with one verify on its pushed tip.

- **a** 47fa2fc: this record (H24, the `./mcp` surface row). **b** (rows a4ed246): the dual-era protocol over stdio.
- **c** f78e656: multipart operations as tools over stdio (inline, `{path}` under a hard FILE_ROOT, caps), the provisional files extension behind one module.
- **d** 55124ff, 60736ad: Streamable HTTP and the standalone `--http`. **e** ad71a48: `mcp()` at `@lovrozagar/honey/mcp`, in-process dispatch, auth before dispatch, the `mcp` e2e app.
- **f** e81ad2f, ae860db: the opt-in OAuth resource server at `./mcp/oauth`; `.output` non-status keys refused where documents are generated.
- **g** 87cf8c8, 53a256c, 52b36b4: remote files, `uploads()` (one-shot HMAC, an app-supplied `UploadStore` with an atomic claim) and `urlFiles()`.
- **h** a124d6c, 9f5f413: the corpus, the docs, a honey-built Worker's named exports, the live Cloudflare leg (8/8 at 51fe6c3).
- **i** (R11, the owner's ruling): the safe API in all six SDKs, a normal client plus a `safe` mirror; i1 946c4fb (TS), i2 b714969 (Python), i3 f516899 (Go), i4 fecce45 (Rust), i5 3af503b (C#), i6 85bdbb6 (Java), i7a e88e5dc (the Java layout), i7b/c e41da49 (a realtime send's over-cap answer is a decode error in all six).
- **i7 gates:** the bench judged on k=3 interleaved passes (ca5f1d5); the e2e time gate's reference timed inside each cell's window (aca6be0); both baselines under one 2% false-red rule (5e1487c).
- **i7d/e** 4ac4ba3: migration.md judged against v0.7.3, the docs name guard, every budget lock its exact bytes with a guarded ledger.

**Open at close:** the 1.0 release notes (CHANGELOG.md, before the tag); the same-runner A/B perf gate (the next bit); the owner's: the first `@lovrozagar/honey-clients` npm publish, the R5 Anyrow note, the docs site deploy.
