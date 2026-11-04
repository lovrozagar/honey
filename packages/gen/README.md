# @lovrozagar/honey-clients

Generates SDKs (TypeScript, Go, Rust, Python, C#, Java), a Go command-line client and a Model Context Protocol
server from an OpenAPI 3.x document, or straight from a
[`@lovrozagar/honey`](https://www.npmjs.com/package/@lovrozagar/honey) app.

Every target reads one intermediate representation and vendors its own small runtime, so a generated SDK has no
dependency on honey, and a spec from another framework generates just as well. The output is formatted and
deterministic: regenerating an unchanged spec changes nothing on disk.

This page is the whole generator — every target, every flag, and what each client looks like to call.

- [Install](#install)
- [Start](#start)
- [honey-clients generate](#honey-clients-generate)
- [Every flag](#every-flag)
- [The six SDKs](#the-six-sdks)
  - [The TypeScript SDK](#the-typescript-sdk)
  - [The Go SDK](#the-go-sdk)
  - [The Rust SDK](#the-rust-sdk)
  - [The Python SDK](#the-python-sdk)
  - [The C# SDK](#the-c-sdk)
  - [The Java SDK](#the-java-sdk)
- [Errors and the safe mirror](#errors-and-the-safe-mirror)
- [The command-line client](#the-command-line-client)
- [The MCP server](#the-mcp-server)
- [Configuring generation](#configuring-generation)
- [What a run writes](#what-a-run-writes)
- [Documentation](#documentation)
- [License](#license)

## Install

1.0 is out as a release candidate, published under npm's `next` tag, so an install without a tag still gives 0.7.3.
Add `@next` until the final release:

```sh
npm install --save-dev @lovrozagar/honey-clients@next
```

Node 22.12 or later, or Bun 1.3 or later.

Each target formats what it writes with that language's own formatter, when it can find it:

| target      | formatter | found by                                                                    |
| ----------- | --------- | --------------------------------------------------------------------------- |
| `go`, `cli` | gofmt     | `$GOFMT`, `$GOROOT/bin/gofmt`, `gofmt` on `PATH`, beside the `go` on `PATH` |
| `python`    | ruff      | `$RUFF`, then `ruff` on `PATH`                                              |
| `rust`      | rustfmt   | `$RUSTFMT`, the active toolchain's own binary beside `rustc`, `PATH`        |
| `ts`        | oxfmt     | the `oxfmt` optional peer, installed beside honey-clients                   |

A formatter it cannot find is named on standard error and skipped: the files go out as the emitter wrote them,
which is valid source either way, so generating a Python SDK never requires you to install ruff. Set
`HONEY_REQUIRE_FORMATTERS=1` to make a missing formatter fail the run instead, for a pipeline that would
rather stop than ship unformatted code. An override that points at nothing is refused by name.

oxfmt is the exception and says nothing when absent: it is honey's own choice of TypeScript formatter and a
declared optional peer, so not having it is the documented normal rather than news. `HONEY_REQUIRE_FORMATTERS`
still stops for it.

The `csharp` and `java` targets are not formatted today: `dotnet format` and google-java-format work over a
project rather than a stream, which honey's post-pass does not yet do.

## Start

From a document:

```sh
npx honey-clients generate --spec openapi.json --target ts --target python --out generated
```

From a honey app module, with no document written first:

```sh
npx honey-clients generate --app src/app.ts --target ts --target go --go-module-path github.com/acme/shop/sdk \
  --out generated
```

The targets are `ts`, `go`, `rust`, `python`, `csharp`, `java`, `cli` and `mcp`. Each target's files go under
`<out>/<target>`.

## honey-clients generate

```sh
honey-clients generate --spec openapi.json --target ts --target cli --out generated \
  --cli-binary-name shop --cli-module-path github.com/acme/shop --cli-repo acme/shop
```

- `--spec <file>`: the OpenAPI document, as JSON.
- `--app <module>[#export]`: a honey app module instead of `--spec` (give one, never both). Its named export, else
  `app`, else `default`, is the app; its document is made by the app's own `@lovrozagar/honey/openapi`, resolved from
  the app as at run time, and the module's `openApi` export, if any, is that document's options (`info`,
  `securitySchemes`, `invalidate`, …, as `generateOpenApi` takes them). Started by `bun run`, the bin hands the load to
  that Bun, so a module needing Bun's loaders works; a run ends once it has written, whatever the module left open.
  The module exports the app and serves nothing: one that calls `serve()` as it loads is outside `--app`'s contract,
  since honey never serves implicitly and has no switch to stop it.
- `--target <name>`: `ts`, `go`, `rust`, `python`, `csharp`, `java`, `cli` or `mcp`; repeat it for more than one.
- `--out <dir>`: each target's files go under `<dir>/<target>`.
- `--<target>-<option>`: a target's options are its generator's, passed through as given. Each takes a value.
- `--watch`: generate again on each change of the spec (or the `--app` module), each run in a fresh process.
- `-h`, `--help`: the usage text, with every target's options.

Parsing is strict, because a typo that generates the wrong thing silently is worse than a refusal: an unknown flag, a
missing value, a stray argument, an unknown target, or an option for a target no `--target` names is a usage error.
`--k v` and `--k=v` both work, and a value is never the next flag.

## Every flag

One table, since a flag that is not written down is a flag nobody finds:

| Flag                       | Target | What it sets                                                                      |
| -------------------------- | ------ | --------------------------------------------------------------------------------- |
| `--spec <file>`            | —      | the OpenAPI document to generate from                                             |
| `--app <module>[#export]`  | —      | a honey app module instead of a document                                          |
| `--target <name>`          | —      | which target to emit; repeat for more than one                                    |
| `--out <dir>`              | —      | the output root; each target writes under `<dir>/<target>`                        |
| `--watch`                  | —      | regenerate on each change, in a fresh process                                     |
| `-h`, `--help`             | —      | the usage text                                                                    |
| `--ts-name`                | ts     | the client class's name (default `SDK`)                                           |
| `--ts-stem`                | ts     | the file stem the generated modules share                                         |
| `--ts-package-name`        | ts     | the npm name, and the JSR name when scoped; the stem by default                   |
| `--ts-version`             | ts     | the version both registries carry; the document's by default                      |
| `--ts-tanstack-query`      | ts     | also write the TanStack Query adapter; takes no value                             |
| `--go-module-path`         | go     | the Go module path the SDK is imported by                                         |
| `--go-version`             | go     | its semver; from v2 on, the major suffix (`/v2`) it puts on the module path       |
| `--rust-crate-name`        | rust   | the crate's name                                                                  |
| `--rust-version`           | rust   | the crate's version                                                               |
| `--rust-description`       | rust   | what crates.io shows; `cargo publish` needs one                                   |
| `--rust-license`           | rust   | its SPDX license; `cargo publish` needs one                                       |
| `--rust-repository`        | rust   | the repository crates.io links                                                    |
| `--rust-homepage`          | rust   | the home page crates.io links                                                     |
| `--rust-keywords`          | rust   | its crates.io keywords, comma separated: five at most, each 20 ASCII characters   |
| `--rust-categories`        | rust   | its crates.io category slugs, comma separated: five at most                       |
| `--rust-documentation`     | rust   | the https documentation crates.io links; docs.rs by default                       |
| `--python-package-name`    | python | the Python package's name                                                         |
| `--python-version`         | python | the package's version                                                             |
| `--csharp-client-name`     | csharp | the client class's name                                                           |
| `--csharp-package-id`      | csharp | the NuGet package id                                                              |
| `--csharp-root-namespace`  | csharp | the root namespace                                                                |
| `--csharp-version`         | csharp | the package's version                                                             |
| `--csharp-description`     | csharp | what nuget.org shows                                                              |
| `--csharp-authors`         | csharp | its authors, comma separated                                                      |
| `--csharp-license`         | csharp | its SPDX license expression                                                       |
| `--csharp-homepage`        | csharp | the https home page nuget.org links                                               |
| `--csharp-repository`      | csharp | the https URL of its git repository                                               |
| `--csharp-copyright`       | csharp | the copyright notice nuget.org shows                                              |
| `--csharp-tags`            | csharp | its NuGet tags, comma separated                                                   |
| `--java-artifact-id`       | java   | the Maven artifact id                                                             |
| `--java-group-id`          | java   | the Maven group id                                                                |
| `--java-package-name`      | java   | the Java package name                                                             |
| `--java-client-name`       | java   | the client class's name                                                           |
| `--java-version`           | java   | the publication's version                                                         |
| `--java-description`       | java   | the POM's description; the document's by default                                  |
| `--java-homepage`          | java   | the POM's https project URL                                                       |
| `--java-license`           | java   | its SPDX license id, linked to spdx.org                                           |
| `--java-repository`        | java   | the https URL of its git repository, the POM's scm                                |
| `--java-developers`        | java   | the POM's developers, comma separated: each a name or `Name <email>`              |
| `--cli-binary-name`        | cli    | the command's own name (`shop`)                                                   |
| `--cli-base-url`           | cli    | the base URL it calls by default; the document's server by default                |
| `--cli-module-path`        | cli    | the Go module path the CLI is built from                                          |
| `--cli-version`            | cli    | its semver; from v2 on, the major suffix (`/v2`) it puts on the module path       |
| `--cli-repo`               | cli    | the GitHub repository its release workflow and install scripts use                |
| `--cli-env-prefix`         | cli    | the prefix of the environment variables it reads                                  |
| `--cli-install-url`        | cli    | the https directory its install scripts are served from; the release's by default |
| `--cli-description`        | cli    | what the package managers show; every channel needs one                           |
| `--cli-homepage`           | cli    | the home page the package managers link; every channel needs one                  |
| `--cli-license`            | cli    | its SPDX license; every channel needs one                                         |
| `--cli-maintainer`         | cli    | `Name <email>`, which AUR and the Linux packages name                             |
| `--cli-homebrew-tap`       | cli    | the Homebrew tap (`owner/name`) its cask is pushed to                             |
| `--cli-scoop-bucket`       | cli    | the Scoop bucket (`owner/name`) its manifest is pushed to                         |
| `--cli-winget-fork`        | cli    | the winget-pkgs fork (`owner/name`) its manifests are proposed from               |
| `--cli-winget-publisher`   | cli    | the publisher winget files it under                                               |
| `--cli-aur`                | cli    | a switch: publish the `<bin>-bin` AUR package                                     |
| `--cli-packages`           | cli    | Linux packages beside the archives: `deb`, `rpm`, `apk`, comma separated          |
| `--mcp-name`               | mcp    | the server's name, and the stem of its bin                                        |
| `--mcp-env-prefix`         | mcp    | the prefix of the environment variables it reads                                  |
| `--mcp-version`            | mcp    | its server info and package version; the document's by default                    |
| `--mcp-package-name`       | mcp    | the npm name it publishes under; `<name>-mcp` by default                          |
| `--mcp-mcp-name`           | mcp    | its MCP registry name (`io.github.acme/shop`), package.json's `mcpName`           |
| `--metadata-description`   | all    | what every registry shows                                                         |
| `--metadata-homepage`      | all    | the https home page the registries link                                           |
| `--metadata-repository`    | all    | the https URL of its git repository                                               |
| `--metadata-license`       | all    | its SPDX license expression                                                       |
| `--metadata-authors`       | all    | each `Name <email>` or a name, comma separated                                    |
| `--metadata-keywords`      | all    | registry keywords, comma separated                                                |
| `--metadata-copyright`     | all    | the copyright line                                                                |
| `--metadata-documentation` | all    | the https URL of its documentation                                                |
| `--metadata-changelog`     | all    | the https URL of its changelog                                                    |
| `--metadata-license-file`  | all    | the license file to ship in each package                                          |
| `--metadata-readme`        | all    | the README to ship in each package                                                |
| `--metadata-icon`          | all    | the package icon to ship where the registry shows one                             |

The `--metadata-<field>` flags fill one package block that every target which publishes reads where its registry has
a place for the field, so a description or license is given once, not once per target. A target's own option of the
same meaning wins: `--java-description` over `--metadata-description`. Each field is checked before anything
generates: URLs must be https, the license an SPDX expression, text one line.

## The six SDKs

Every SDK takes the same configuration — a base URL, the auth the spec's security scheme names, a timeout, retries,
hooks around each HTTP call, and per-call overrides — and every one answers the same way: the normal call returns
your value and throws a typed error by status, while `client.safe` answers a result instead. What follows is each
language's client in a slice of a compiled example; the
[SDK recipes](https://github.com/lovrozagar/honey/blob/main/docs/sdk-recipes.md) page has the whole programs.

### The TypeScript SDK

```sh
honey-clients generate --spec openapi.json --target ts --out generated --ts-name Kitchen
```

```ts sdk
import { DecodeError, Kitchen, NotFoundError } from "./kitchen"

export function newClient(): Kitchen {
	return new Kitchen({
		baseURL: "https://api.example.com",
		headers: { authorization: `Bearer ${process.env.KITCHEN_TOKEN ?? ""}` },
		timeout: 10_000,
	})
}

export async function organization(client: Kitchen, orgId: string): Promise<string | null> {
	try {
		await client.getApiV1OrganizationsByOrgId({ params: { orgId } })
		return orgId
	} catch (error) {
		if (error instanceof NotFoundError) return null
		throw error
	}
}

export async function health(client: Kitchen): Promise<string> {
	const result = await client.safe.getApiHealth()
	if (result.ok) return "up"
	if (result.error instanceof DecodeError) return `unreadable answer: ${result.error.message}`
	return `answered ${result.error.status}`
}
```

#### Publishing it to npm and JSR

The target writes a package around the SDK, so the output directory publishes as it is. The sources stay where a
workspace imports them; they import each other as `.js`, which every TypeScript resolution and bundler maps to the
`.ts` file. Node will not strip types under `node_modules`, so `dist/` holds each source compiled to ES module
JavaScript beside its declarations, and `package.json` exports those: the root, `./webhook` when the document has
webhook events, and `./tanstack-query` with `@tanstack/query-core` as an optional peer. A scoped `--ts-package-name`
also gets a `jsr.json` that publishes the sources themselves, its `.js` imports mapped to their `.ts` files.
`--metadata-*` fills description, keywords, homepage, bugs, license, author and repository.

```sh
honey-clients generate --spec openapi.json --target ts --out generated --ts-name Kitchen \
  --ts-package-name @acme/kitchen --ts-version 1.4.0 --metadata-license MIT
```

#### TanStack Query, from the same document

`--ts-tanstack-query` writes one more file beside the SDK, `<stem>.tanstack-query.gen.ts`. It takes no value:

```sh
honey-clients generate --spec openapi.json --target ts --out generated --ts-name Kitchen --ts-tanstack-query
```

Its `createQueryHelpers(sdk, { getQueryClient })` gives five surfaces — `query`, `mutation`, `infiniteQuery`,
`queryKey` and `mutationKey` — each nested exactly as the client is, so `query.org.member.list(…)` sits where
`client.org.member.list(…)` does. `sdk` may be a client or a thunk for one, which an isomorphic app needs.

The document decides what goes where. A `GET` is on `query`, every other method is on `mutation`, and an event
stream, a WebSocket or an `x-realtime` operation is on neither, because a stream is not a cache entry. Nothing
is keyed off a method's name.

**Keys.** A read's key is `[<SDK name>, ...the member path, the request]` — the request object whole, so
`params`, `search` and anything else the SDK sends are all in it. That is what TanStack requires: every input
the `queryFn` depends on belongs in the key, so two reads of one route that differ only by `search` are two
cache entries. `init` is not in the key, since a signal and a timeout say nothing about the answer. A read with
no request keys as `[<SDK name>, ...the member path]`. `queryKey.<…>(req)` returns exactly the key
`query.<…>({ reqOptions: { req } })` writes. A paged read carries a trailing `"infinite"` marker, because its
cached shape is `InfiniteData` and it must not share the plain read's entry.

**Invalidation** works by prefix, which is why the two are not the same shape. A successful write makes stale
the reads its `x-invalidate` selectors name, with the mutation's own path params filled in:
`[<SDK name>, ...the member path, { params }]`. TanStack matches objects partially and compares only the
filter's own positions, so that reaches every search of that read, the paged entry included. When a selector's
params are not all known the filter stays the bare prefix, which reaches everything under it — made stale
rather than missed.

Two notes. `@tanstack/query-core` is your dependency, not honey's — install it yourself; the file imports it for
types only. And a read's options carry `initialData: undefined`, which is what solid-query needs to keep the
unseeded overload; it is harmless under react-query.

Drop the flag and the next run deletes the file, the way `.honey-generated.json` deletes anything the previous
run wrote and this one did not. The index file never re-exports the adapter, so an SDK generated without the
flag names no TanStack type anywhere.

### The Go SDK

Idiomatic Go: a `Config`, `context.Context` on every call, errors read with `errors.As`, and an event stream as a
`range` over a function.

```sh
honey-clients generate --spec openapi.json --target go --out generated --go-module-path github.com/acme/shop/sdk
```

Go wants a v2-or-later module's major version at the end of its path, so pass the base path and the version:
`--go-version 2.1.0` makes go.mod declare `github.com/acme/shop/sdk/v2`, and the CLI target's `--cli-version` does the
same for its module and the version it links in. A path Go would not publish (no domain first, or a suffix such as
`/v1`) is refused, as is a suffix next to a version, since the version gives it.

```go
func listing(ctx context.Context, client *sdk.Client) string {
	r, err := client.Safe().GetApi(ctx, nil)
	if err != nil {
		return fmt.Sprintf("no answer: %v", err) // never sent, refused, dropped, timed out or canceled
	}
	var unreadable *sdk.DecodeError
	var failed *sdk.ClientError
	switch {
	case r.Ok():
		return fmt.Sprintf("answered %d: %v", r.Response.StatusCode, r.Data)
	case errors.As(r.Err, &unreadable):
		return fmt.Sprintf("answered %d, unreadable: %v", r.Response.StatusCode, unreadable.Err)
	case errors.As(r.Err, &failed):
		return fmt.Sprintf("answered %d: %s", failed.StatusCode, failed.Key)
	}
	return r.Err.Error()
}
```

### The Rust SDK

Async over `reqwest`, each call taking its options struct, with the safe mirror as a second client style.

```sh
honey-clients generate --spec openapi.json --target rust --out generated --rust-crate-name shop-sdk
```

```rust
async fn listing(client: &Client) -> String {
    match client.safe().get_api(&GetApiOpts::default()).await {
        Ok(Answer::Ok { data, response }) => format!("answered {}: {data:?}", response.status),
        Ok(Answer::Err {
            error: SafeError::Api(failed),
            response,
        }) => format!("answered {}: {}", response.status, failed.message()),
        Ok(Answer::Err {
            error: SafeError::Decode(unreadable),
            response,
        }) => format!("answered {}, unreadable: {unreadable}", response.status),
        Err(no_answer) => format!("no answer: {no_answer}"), // never sent, refused, timed out or canceled
    }
}
```

### The Python SDK

A sync `SDK` and an async `AsyncSDK`, both context managers, typed for `mypy --strict`, with results as frozen
dataclasses to narrow with `match`.

```sh
honey-clients generate --spec openapi.json --target python --out generated --python-package-name shop_sdk
```

`pyproject.toml` builds with hatchling and carries what PyPI shows: `--metadata-*` gives the description, the SPDX
`license` (PEP 639, so no `License ::` classifier), authors, keywords, and `[project.urls]` (Homepage, Source,
Issues, Documentation, Changelog). The classifiers name the Python versions honey tests and `Typing :: Typed`, and
honey's own manifest stays out of the sdist.

```python
async def health(client: AsyncSDK) -> str:
    match await client.safe.get_api_health():
        case Ok(data, response):
            return f"answered {response.status}: {data}"
        case Err(DecodeError() as unreadable, response):
            return f"answered {response.status}, unreadable: {unreadable}"
        case Err(error, response):
            return f"answered {response.status}: {error}"
```

### The C# SDK

A .NET project with its own `HttpClient` pipeline, `IAsyncDisposable` streams, and `client.Safe` answering
`Result<T>`.

```sh
honey-clients generate --spec openapi.json --target csharp --out generated --csharp-package-id Acme.Shop
```

nuget.org shows a package's description, authors, license and links: give them with `--csharp-description`,
`--csharp-authors`, `--csharp-license`, `--csharp-homepage` and `--csharp-repository`, and the `.csproj` carries them
into `dotnet pack`.

```csharp
    public static async Task<string> Listing(HoneySdkClient client, string id)
    {
        var result = await client.Safe.GetApiAsync(id); // no answer (never sent, refused, timed out, canceled) still throws
        return result.Match(
            found => $"answered {result.Response.Status}: {found}",
            error => error switch
            {
                DecodeException unreadable => $"answered {result.Response.Status}, unreadable: {unreadable.Message}",
                ApiStatusException failed => $"answered {failed.Status}: {failed.Key}",
                _ => error.Message,
            });
    }
```

### The Java SDK

A Java 17 library on Jackson 3, with builders, `try`-with-resources streams, `client.safe()` answering a sealed
`Result<T>`, and a Gradle publication.

```sh
honey-clients generate --spec openapi.json --target java --out generated --java-group-id com.acme
```

Maven Central refuses a POM without a URL, a license, a developer and scm: give them with `--java-homepage`,
`--java-license`, `--java-developers "Name <email>, Other Name"` and `--java-repository`, or once for every target in
the metadata block, whose authors are the POM's developers. Signing the publication stays yours.

```java
  static String listing(KitchenClient client) {
    // no answer (never sent, refused, timed out, canceled) still throws
    Result<ListApiResponse200> result = client.safe().getApi(GetApiParams.builder().build());
    int status = result.response().status();
    return result.fold(
        found -> "answered " + status + ": " + found,
        error ->
            error instanceof ApiException failed
                ? "answered " + status + ": " + failed.key()
                : "answered " + status + ", unreadable: " + error.getMessage());
  }
```

## Errors and the safe mirror

Two styles, in all six SDKs, over the same calls:

- **The normal call** answers its value and throws on any failure: an error status as its typed error
  (`NotFoundError` and so on, each a `ClientError`), and an undecodable or over-cap 2xx as a `DecodeError`.
- **`client.safe`** holds the same calls, each answering a result. On `ok` it carries the data, the raw response, and
  the declared response headers when the operation has any. Otherwise it carries the error the normal call would have
  thrown, with the parsed body on it. A declared status narrows the error's type and body; any other status is the
  base client error with an `unknown` body.
- **No answer throws in both styles.** A call never sent, a refused or dropped connection, a timeout, a cancel, and a
  stream that drops after it opened are not answers, so there is nothing for a result to carry.

A name of yours that collides with the mirror, or with a runtime type, is renamed and reported on stderr — never
silently. An operation or root resource named `safe` becomes `safe_`, and a component named like one of the runtime
types becomes `<Name>Model`.

Full reference: [generated clients](https://github.com/lovrozagar/honey/blob/main/docs/client.md).

## The command-line client

`--target cli` writes a Go command-line client for the API: one command per operation, grouped by its dotted
`operationId`, with `--help` everywhere, `commands` and `schema` for discovery, typed flags, table/JSON/NDJSON/YAML
output, streams, pagination, shell completion, and an embedded `SKILL.md` so an agent can drive it. It ships with a
release workflow, which can publish to Homebrew, Scoop, winget, AUR and deb/rpm/apk packages, and, with `--cli-repo`,
install scripts that verify what they install.

```sh
honey-clients generate --spec openapi.json --target cli --out ./cli --cli-repo acme/shop-cli
shop orders list --status open --output json
```

| Value                                                               | Default         | What it does                                         |
| ------------------------------------------------------------------- | --------------- | ---------------------------------------------------- |
| a command per operation                                             | —               | grouped by the dotted operationId resource tree      |
| `--json`                                                            | off             | one machine-readable shape on every command          |
| `--output <json\|ndjson\|yaml\|table>`                              | table           | human and machine formats                            |
| `--api-key` / `--base-url` / `--config` / `--timeout` / `--verbose` | from config/env | auth, target, config file, deadline, logging         |
| `commands`, `schema`                                                | —               | a listable command index and per-call schemas        |
| `--output <file>`                                                   | stdout          | a binary response written as bytes, pipe-safe        |
| exit codes                                                          | usage/standard  | non-zero on usage error, distinct from a runtime one |

Its configuration has one precedence, everywhere: **flag, then environment, then config file.** The environment
variables are the `--cli-env-prefix` (or the API's name) upper-cased.

Full reference: [the generated CLI](https://github.com/lovrozagar/honey/blob/main/docs/cli.md) and
[releasing it](https://github.com/lovrozagar/honey/blob/main/docs/cli-release.md).

## The MCP server

`--target mcp` writes a standalone Model Context Protocol server: one tool per operation marked for MCP, its
`inputSchema` from the operation's parameters and body, an `outputSchema` from its success response, and
`structuredContent` an agent reads as data beside a text rendering. A failure comes back as a tool error with its
status and key, never as a successful result. Read-only operations are annotated as such. It speaks stdio by
default, and Streamable HTTP with `--http`.

```sh
honey-clients generate --spec openapi.json --target mcp --out ./mcp --mcp-name anyrow
```

Its package publishes to npm as written. `--mcp-package-name @acme/shop-mcp` names it (its bin keeps the server's
name), the metadata block fills its description, license, repository and the rest as it does the TS SDK's, and
`--mcp-mcp-name io.github.acme/shop` writes the `mcpName` the MCP registry checks the npm package by.

```json
{
	"name": "orders_get",
	"inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] },
	"outputSchema": { "type": "object", "properties": { "id": { "type": "string" }, "status": { "type": "string" } } }
}
```

The server reads its configuration from the environment, under the `--mcp-env-prefix` (or the document's title,
upper-cased):

| Variable                     | Default                     | What it does                                                                                      |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `$<PREFIX>_BASE_URL`         | the document's first server | the API every call goes to                                                                        |
| `$<PREFIX>_API_KEY`          | none                        | the credential, sent as the document's scheme says; scrubbed from every result                    |
| `$<PREFIX>_HEADERS`          | none                        | a JSON object of headers sent on every call, each scrubbed from results                           |
| `$<PREFIX>_REDIRECT`         | `same-origin`               | `same-origin`, or `follow` to follow a redirect off the API's origin with its credentials dropped |
| `$<PREFIX>_TIMEOUT_MS`       | `30000`                     | each call's bound, an event stream's collect included                                             |
| `$<PREFIX>_FILE_ROOT`        | the client's working dir    | the only directory a `{ path }` file argument is read from                                        |
| `$<PREFIX>_MAX_FILE_BYTES`   | `52428800`                  | the largest file a path may name                                                                  |
| `$<PREFIX>_MAX_INLINE_BYTES` | `1048576`                   | all inline files of one call together, decoded                                                    |
| `$<PREFIX>_MCP_TOKEN`        | none                        | the bearer token `--http` requires; it never reaches the API                                      |

**The standalone server needs Node**: it holds a listening socket and reads local files, so it belongs on a machine
or a container, never on serverless or Workers. To serve the same tools remotely, mount them in the app instead with
`mcp()` from `@lovrozagar/honey/mcp`, which runs wherever the app runs and is guarded by the app's own auth.

Full reference: [the generated MCP server](https://github.com/lovrozagar/honey/blob/main/docs/mcp.md).

## Configuring generation

In a honey project the generation is configured once, in the Vite plugin, and `honey-clients generate --app` reads
the same app. `codegen.mcp` writes the handler `mcp()` mounts, and `codegen.openApi` the document the SDKs are
generated from:

```sh
# the whole set, from the app module, in one run
npx honey-clients generate --app src/app.ts \
  --target ts --target go --target python --target cli --target mcp \
  --go-module-path github.com/acme/shop/sdk --cli-repo acme/shop-cli --out generated
```

```json
{
	"scripts": {
		"generate": "honey generate && honey-clients generate --app src/app.ts --target ts --out generated"
	}
}
```

What each target names its package, its client class and its environment variables is the `--<target>-<option>` set
above; nothing is read from a config file of ours, so one command line is the whole input and a CI run cannot drift
from a developer's.

## What a run writes

**Stale files are deleted, edited ones kept.** Each `<out>/<target>` keeps `.honey-generated.json`: every file the
run wrote, with its sha256. A file is rewritten only when its bytes change, through a temp file renamed over it. A
regeneration deletes a file the last run wrote and this one does not (a `cli` target's old `<name>_cmds.go`, say),
unless it was edited since: that one is kept and named on stderr. A file the manifest never listed is never deleted,
nothing outside `<out>/<target>` is touched, and no symlink is followed. Without a manifest, nothing is deleted.

Every target is held to the same conformance grid: one shared scenario suite runs against a live reference server
for all eight targets, and each decoded answer and each request on the wire must match one expected table. A feature
that works in one SDK and breaks in another fails the grid.

To lay the files out yourself, `generated(run, document, ctx)` from `@lovrozagar/honey-clients` returns each
target's files unwritten, and `writeTarget(dir, files)` writes one target's into a directory you pick under the same
rules, keeping `MANIFEST` (`.honey-generated.json`) there. A file the last call wrote that you leave out of `files` is
stale: deleted if unedited, kept and named in the result's `kept` if you changed it, and dropped from the manifest
either way, so a file you take over by editing is never touched again.

A run kept as data (a release manifest, say) is checked with the same tables the command parses. `TARGETS` lists
every target, and `targetOptionSchemas[target]` is a Standard Schema for that target's options: its option names only,
each a non-empty string, a switch `"true"` or `"false"`. `generated` checks each target's options with it before
anything generates, and `GenerateRun` types them by target, so a misspelled option is a type error, then a refusal.
`GenerateRun`'s `metadata` is the `--metadata-<field>` block as a `Metadata` object, `authors` and `keywords` as
arrays, checked with the same rules.

```ts
import { TARGETS, targetOptionSchemas } from "@lovrozagar/honey-clients"

const result = targetOptionSchemas.go["~standard"].validate({ modulePath: "github.com/acme/shop-go" })
export const ok = result.issues === undefined && TARGETS.includes("go")
```

This package also exports the app-side generators the honey CLI and Vite plugin use: `generateRouteTree`,
`generateTypes` and `extractTypes` from `@lovrozagar/honey-clients`, and the command's own entry at
`@lovrozagar/honey-clients/cli`.

## Documentation

- [Code generation](https://github.com/lovrozagar/honey/blob/main/docs/codegen.md): every target and its options.
- [Generated clients](https://github.com/lovrozagar/honey/blob/main/docs/client.md) and their
  [per-language recipes](https://github.com/lovrozagar/honey/blob/main/docs/sdk-recipes.md).
- [The generated CLI](https://github.com/lovrozagar/honey/blob/main/docs/cli.md),
  [releasing it](https://github.com/lovrozagar/honey/blob/main/docs/cli-release.md), and
  [the MCP server](https://github.com/lovrozagar/honey/blob/main/docs/mcp.md).
- [SDK conformance](https://github.com/lovrozagar/honey/blob/main/docs/conformance.md) and
  [the framework itself](https://github.com/lovrozagar/honey/blob/main/packages/core/README.md).

## License

MIT
