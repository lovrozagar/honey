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

The `go` and `cli` targets format every Go file they write with gofmt, so they need Go installed. gofmt is found by
`$GOFMT`, then `$GOROOT/bin/gofmt`, then `gofmt` on `PATH`, then beside the `go` on `PATH`. Without one they refuse,
rather than writing unformatted Go. The `ts` target formats with oxfmt, an optional peer: install `oxfmt` beside
honey-clients. Without it the files go out as emitted, valid TypeScript that is not formatted.

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

| Flag                      | Target | What it sets                                                       |
| ------------------------- | ------ | ------------------------------------------------------------------ |
| `--spec <file>`           | —      | the OpenAPI document to generate from                              |
| `--app <module>[#export]` | —      | a honey app module instead of a document                           |
| `--target <name>`         | —      | which target to emit; repeat for more than one                     |
| `--out <dir>`             | —      | the output root; each target writes under `<dir>/<target>`         |
| `--watch`                 | —      | regenerate on each change, in a fresh process                      |
| `-h`, `--help`            | —      | the usage text                                                     |
| `--ts-name`               | ts     | the client class's name (default `SDK`)                            |
| `--ts-stem`               | ts     | the file stem the generated modules share                          |
| `--go-module-path`        | go     | the Go module path the SDK is imported by                          |
| `--rust-crate-name`       | rust   | the crate's name                                                   |
| `--rust-version`          | rust   | the crate's version                                                |
| `--python-package-name`   | python | the Python package's name                                          |
| `--python-version`        | python | the package's version                                              |
| `--csharp-client-name`    | csharp | the client class's name                                            |
| `--csharp-package-id`     | csharp | the NuGet package id                                               |
| `--csharp-root-namespace` | csharp | the root namespace                                                 |
| `--csharp-version`        | csharp | the package's version                                              |
| `--java-artifact-id`      | java   | the Maven artifact id                                              |
| `--java-group-id`         | java   | the Maven group id                                                 |
| `--java-package-name`     | java   | the Java package name                                              |
| `--java-client-name`      | java   | the client class's name                                            |
| `--java-version`          | java   | the publication's version                                          |
| `--cli-binary-name`       | cli    | the command's own name (`shop`)                                    |
| `--cli-module-path`       | cli    | the Go module path the CLI is built from                           |
| `--cli-repo`              | cli    | the GitHub repository its release workflow and install scripts use |
| `--cli-env-prefix`        | cli    | the prefix of the environment variables it reads                   |
| `--mcp-name`              | mcp    | the server's name, and the stem of its bin                         |
| `--mcp-env-prefix`        | mcp    | the prefix of the environment variables it reads                   |

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

### The Go SDK

Idiomatic Go: a `Config`, `context.Context` on every call, errors read with `errors.As`, and an event stream as a
`range` over a function.

```sh
honey-clients generate --spec openapi.json --target go --out generated --go-module-path github.com/acme/shop/sdk
```

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
release workflow and install scripts that verify what they install.

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
