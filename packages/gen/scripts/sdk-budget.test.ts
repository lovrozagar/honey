import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { runtimeFileNames } from "../src/emit/go/http.ts"
import { csharpCallPlans, generateCSharpSdk } from "../src/emit/csharp/sdk.ts"
import { generateGoSdk, goCallPlans } from "../src/emit/go/sdk.ts"
import { generatePythonSdk, pythonCallPlans } from "../src/emit/python/sdk.ts"
import { runtimeFileNames as pythonRuntimeFileNames } from "../src/emit/python/transport.ts"
import { runtimeFileNames as rustRuntimeFileNames } from "../src/emit/rust/http.ts"
import { generateRustSdk, rustCallPlans } from "../src/emit/rust/sdk.ts"
import { RUNTIME_MODULES } from "../src/emit/ts/http.ts"
import { generateSdk } from "../src/emit/ts/sdk.ts"
import { ceilingOf, countTokens, oversizedOperations } from "./capture-token-budget.ts"
import {
	runtimeBytes,
	v1CSharpSdkSurfaces,
	v1GoSdkSurfaces,
	v1PythonSdkSurfaces,
	v1RustSdkSurfaces,
	v1SdkSurfaces,
} from "./sdk-budget.ts"

const REPO = resolve(import.meta.dirname, "../../..")
const APPS = ["compose", "defaults", "gateway", "kitchen", "surface"]
/** An e2e app's emitted OpenAPI document. */
const appSpec = (app: string) =>
	JSON.parse(
		readFileSync(join(REPO, `packages/core/tests/e2e/apps/${app}/src/_gen/openapi.gen.json`), "utf8"),
	) as Record<string, unknown>
/** A vendored runtime's directory. */
const runtimeDir = (language: string) => join(REPO, `packages/gen/src/runtime/${language}`)

describe("the v1 SDK within the budget (bit 11)", () => {
	it("reads each operation's signature lines, its raw overload with its call, a repeated name numbered", () => {
		const raw = "get(input: A & { raw: true }): Promise<Response>"
		const types = `interface Ops {\n\titems: {\n\t\t${raw}\n\t\tget(input?: A): R\n\t}\n\tusers: {\n\t\tget(input?: B): S\n\t}\n\t"x-y"(input?: C): T\n}`
		expect(Object.fromEntries(v1SdkSurfaces(types))).toEqual({
			'"x-y"': '"x-y"(input?: C): T',
			get: `${raw}\nget(input?: A): R`,
			"get#2": "get(input?: B): S",
		})
	})

	it("keeps every e2e app's operations within the sdkCli and document ceilings", () => {
		const baseline = JSON.parse(readFileSync(join(REPO, "blueprint/baselines/tokens.json"), "utf8")) as {
			document: { ceiling: number }
			sdkCli: { ceiling: number }
		}
		const over: string[] = []
		for (const app of APPS) {
			const file = join(REPO, `packages/core/tests/e2e/apps/${app}/src/_gen/openapi.gen.json`)
			const spec = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & { paths: Record<string, never> }
			const { files, stem } = generateSdk(spec, { name: "SDK" })
			for (const [name, text] of v1SdkSurfaces(files[`${stem}.types.gen.ts`] ?? ""))
				if (countTokens(text) > baseline.sdkCli.ceiling) over.push(`${app}/${name}`)
			over.push(...oversizedOperations(spec, baseline.document.ceiling).map((id) => `${app}/${id} (document)`))
		}
		expect(over).toEqual([])
	})
})

/*
 * G13 (bit 12): Go's own per-operation ceiling, not sdkCli's 234. Measured over the five e2e apps'
 * 72 operations in both throwOnError modes (144 surfaces, `v1GoSdkSurfaces` over the pre-gofmt
 * client.go): max 78 (surface, PutInAllByResourceId, safe mode), median 43; gofmt's field alignment
 * moves the max to 79. 78 + 20% headroom = 94. Each language holds its own ceiling, set from its
 * own measurement: Go's surface is a third of TS's, so the shared one would let it triple unseen.
 * An operation over it is fixed in the schema, never by raising the ceiling; revisit only for a
 * genuinely large, legitimate operation.
 */
const GO_SDK_CEILING = 94

const GO_CLIENT = `package sdk

// Get calls GET /a.
func (r *Client) Get(ctx context.Context, opts *GetOpts, reqOpts ...RequestOption) (SDKResult[A], error) {
\treturn get(ctx)
}

func (r *ItemsResource) Get(ctx context.Context, id string, reqOpts ...RequestOption) error {
\treturn nil
}

func (r *Client) helper(x int) {
}

// GetOpts holds the optional parameters of get.
type GetOpts struct {
\t// Limit caps the page.
\tLimit *int
}

type EmptyOpts struct {
}
`

describe("the v1 Go SDK within the budget (bit 12, G13)", () => {
	it("reads each method's signature with its Opts block, keyed receiver.method", () => {
		expect(Object.fromEntries(v1GoSdkSurfaces(GO_CLIENT))).toEqual({
			"Client.Get": [
				"func (r *Client) Get(ctx context.Context, opts *GetOpts, reqOpts ...RequestOption) (SDKResult[A], error)",
				"type GetOpts struct {",
				"\t// Limit caps the page.",
				"\tLimit *int",
				"}",
			].join("\n"),
			"ItemsResource.Get":
				"func (r *ItemsResource) Get(ctx context.Context, id string, reqOpts ...RequestOption) error",
		})
	})

	it("refuses a method whose Opts struct is never declared, so a missed block never measures short", () => {
		const text = GO_CLIENT.replace("type GetOpts struct", "type OtherOpts struct")
		expect(() => v1GoSdkSurfaces(text)).toThrow("Client.Get takes GetOpts, which is never declared")
	})

	it(`keeps every e2e app's Go operations within ${GO_SDK_CEILING} tokens, in both throwOnError modes`, () => {
		const over: string[] = []
		for (const app of APPS) {
			const spec = appSpec(app)
			for (const throwOnError of [true, false]) {
				const options = { modulePath: "example.com/budget", throwOnError }
				const surfaces = v1GoSdkSurfaces(generateGoSdk(spec, options).files["client.go"] ?? "")
				/* completeness: a surface the regex misses can never pass by going unmeasured */
				const plans = Object.keys(goCallPlans(spec, options)).length
				if (surfaces.size !== plans) over.push(`${app}: ${surfaces.size} of ${plans} measured`)
				for (const [key, text] of surfaces) {
					const tokens = countTokens(text)
					if (tokens > GO_SDK_CEILING) over.push(`${app}/${key}${throwOnError ? "" : " (safe)"}: ${tokens}`)
				}
			}
		}
		expect(over).toEqual([])
	})
})

/*
 * G13 (bit 13): Rust's own per-operation ceiling, not sdkCli's 234 nor Go's 94. Measured over the five e2e
 * apps' 72 operations in both throwOnError modes (144 surfaces, `v1RustSdkSurfaces` over the pre-rustfmt
 * src/client.rs): max 80 (surface, put_in_all_by_resource_id, safe mode), median 37, min 26; rustfmt wraps
 * a long signature one parameter per line, which moves the max to 86 and the median to 39. 80 + 20% headroom
 * = 96. Each language holds its own ceiling, set from its own measurement. An operation over it is fixed in
 * the schema, never by raising the ceiling; revisit only for a genuinely large, legitimate operation.
 */
const RUST_SDK_CEILING = ceilingOf([80], 0.2)

const RUST_CLIENT = `// @generated by honey. DO NOT EDIT.
//! The client, its resources and their operations.

use crate::*;

impl Client {
    /// The client for \`config\`.
    pub fn new(config: ClientConfig) -> Result<Client, Error> {
        Client::build(config, crate::config::Defaults { base_url: None })
    }

    pub fn items(&self) -> ItemsResource<'_> {
        ItemsResource { client: self }
    }

    /// Sends \`GET /a\`.
    #[allow(clippy::too_many_arguments)]
    pub fn get(&self, id: &str, opts: &GetOpts) -> Call<SdkResult<A>> {
        Call::new(self, spec, crate::answer::safe_json::<A>)
    }
}

impl ItemsResource<'_> {
    pub fn get(&self, _opts: &ItemsGetOpts) -> Call<()> {
        Call::new(self.client, spec, crate::answer::none)
    }

    pub fn r#type(&self, body: Item, _opts: &ItemsGetOpts) -> Call<Item, ItemsTypeHeaders> {
        Call::new(self.client, spec, crate::answer::json::<Item>)
    }
}

/// The parameters of getA beyond its path and body.
#[derive(Debug, Clone, Default)]
pub struct GetOpts {
    /// Required by the API.
    pub limit: i64,
    pub cursor: Option<String>,
}

/// The parameters of items.get beyond its path and body.
#[derive(Debug, Clone, Default)]
pub struct ItemsGetOpts {}
`

describe("the v1 Rust SDK within the budget (bit 13, G13)", () => {
	it("reads each operation's signature with its Opts block, keyed type.method, never new or an accessor", () => {
		expect(Object.fromEntries(v1RustSdkSurfaces(RUST_CLIENT))).toEqual({
			"Client.get": [
				"pub fn get(&self, id: &str, opts: &GetOpts) -> Call<SdkResult<A>>",
				"pub struct GetOpts {",
				"    /// Required by the API.",
				"    pub limit: i64,",
				"    pub cursor: Option<String>,",
				"}",
			].join("\n"),
			"ItemsResource.get": "pub fn get(&self, _opts: &ItemsGetOpts) -> Call<()>\npub struct ItemsGetOpts {}",
			"ItemsResource.r#type":
				"pub fn r#type(&self, body: Item, _opts: &ItemsGetOpts) -> Call<Item, ItemsTypeHeaders>\npub struct ItemsGetOpts {}",
		})
	})

	it("refuses a method whose Opts is never declared, or that names none, so a missed block never measures short", () => {
		const renamed = RUST_CLIENT.replace("pub struct GetOpts {", "pub struct OtherOpts {")
		expect(() => v1RustSdkSurfaces(renamed)).toThrow("Client.get takes GetOpts, which is never declared")
		const unnamed = RUST_CLIENT.replace("_opts: &ItemsGetOpts) -> Call<()>", "_opts: &()) -> Call<()>")
		expect(() => v1RustSdkSurfaces(unnamed)).toThrow("ItemsResource.get takes no Opts")
	})

	it(`keeps every e2e app's Rust operations within ${RUST_SDK_CEILING} tokens, in both throwOnError modes`, () => {
		const over: string[] = []
		for (const app of APPS) {
			const spec = appSpec(app)
			for (const throwOnError of [true, false]) {
				const surfaces = v1RustSdkSurfaces(generateRustSdk(spec, { throwOnError }).files["src/client.rs"] ?? "")
				/* completeness: a surface the regex misses can never pass by going unmeasured */
				const plans = Object.keys(rustCallPlans(spec, { throwOnError })).length
				if (surfaces.size !== plans) over.push(`${app}: ${surfaces.size} of ${plans} measured`)
				for (const [key, text] of surfaces) {
					const tokens = countTokens(text)
					if (tokens > RUST_SDK_CEILING) over.push(`${app}/${key}${throwOnError ? "" : " (safe)"}: ${tokens}`)
				}
			}
		}
		expect(over).toEqual([])
	})
})

/*
 * G13 (bit 14): Python's own per-operation ceiling, not sdkCli's 234 nor Go's 94 or Rust's 96. Measured over the
 * five e2e apps' 72 operations in both throwOnError modes (144 surfaces, `v1PythonSdkSurfaces` over the pre-format
 * client.py): max 59 (surface, AsyncSDK.put_in_all_by_resource_id, safe mode), median 26, min 18
 * (compose, AsyncSDK.get_account); ruff's format pass wraps a long signature one parameter per line, which moves
 * the max to 70 and the median to 30. 59 + 20% headroom = 71. Each language holds its own ceiling, set from its
 * own measurement. An operation over it is fixed in the schema, never by raising the ceiling; revisit only for a
 * genuinely large, legitimate operation.
 */
const PYTHON_SDK_CEILING = ceilingOf([59], 0.2)

const PY_CLIENT = `class UsersResource:
    def get(self, id: str, *, options: RequestOptions | None = None) -> User:
        return self._core.call(spec)


class AsyncUsersResource:
    def __init__(self, core: AsyncCore) -> None:
        self._core = core

    async def get(self, id: str, *, options: RequestOptions | None = None) -> User:
        """Sends \`GET /users/{id}\`."""
        return await self._core.call(spec)


class AsyncSDK:
    async def aclose(self) -> None:
        await self._core.aclose()

    async def __aenter__(self) -> Self:
        return self

    async def list(self, *, limit: int | None = None, options: RequestOptions | None = None) -> _builtins.list[User]:
        return await self._core.call(spec)
`

describe("the v1 Python SDK within the budget (bit 14, G13)", () => {
	it("reads each async operation's signature line, keyed class.method, never the sync twin or a lifecycle method", () => {
		expect(Object.fromEntries(v1PythonSdkSurfaces(PY_CLIENT))).toEqual({
			"AsyncSDK.list":
				"async def list(self, *, limit: int | None = None, options: RequestOptions | None = None) -> _builtins.list[User]",
			"AsyncUsersResource.get": "async def get(self, id: str, *, options: RequestOptions | None = None) -> User",
		})
	})

	it("refuses a signature that spans lines, so a formatted client never measures short", () => {
		const wrapped = PY_CLIENT.replace(
			"    async def get(self, id: str, *, options",
			"    async def get(\n        self, id: str, *, options",
		)
		expect(() => v1PythonSdkSurfaces(wrapped)).toThrow("AsyncUsersResource.get spans lines")
	})

	it(`keeps every e2e app's Python operations within ${PYTHON_SDK_CEILING} tokens, in both throwOnError modes`, () => {
		const over: string[] = []
		for (const app of APPS) {
			const spec = appSpec(app)
			for (const throwOnError of [true, false]) {
				const files = generatePythonSdk(spec, { throwOnError }).files
				const surfaces = v1PythonSdkSurfaces(files["src/honey_sdk/client.py"] ?? "")
				/* completeness: a surface the regex misses can never pass by going unmeasured */
				const plans = Object.keys(pythonCallPlans(spec, { throwOnError })).length
				if (surfaces.size !== plans) over.push(`${app}: ${surfaces.size} of ${plans} measured`)
				for (const [key, text] of surfaces) {
					const tokens = countTokens(text)
					if (tokens > PYTHON_SDK_CEILING) over.push(`${app}/${key}${throwOnError ? "" : " (safe)"}: ${tokens}`)
				}
			}
		}
		expect(over).toEqual([])
	})
})

/*
 * G13 (bit 15): C#'s own per-operation ceiling, not sdkCli's 234 nor Go's 94, Rust's 96 or Python's 71. Measured over
 * the five e2e apps' 72 operations in both throwOnError modes (144 surfaces, `v1CSharpSdkSurfaces` over the emitted
 * Client.cs): max 56 (surface, PutInAllByResourceId, safe mode), median 27, min 19. The emitter writes no formatter
 * pass, so the measured text is the shipped text. 56 + 20% headroom = 68. Each language holds its own ceiling, set
 * from its own measurement. An operation over it is fixed in the schema, never by raising the ceiling; revisit only
 * for a genuinely large, legitimate operation.
 */
const CSHARP_SDK_CEILING = ceilingOf([56], 0.2)

const CS_CLIENT = `namespace Acme;

public sealed class HoneySdkClient
{
    public Task<SdkResult<A>> GetAAsync(string id, RequestOptions? options = null, CancellationToken cancellationToken = default) => Call(id, options);
    public Task<B> ListAsync(RequestOptions? options = null, CancellationToken cancellationToken = default)
    {
        return Call(options);
    }
}

public sealed partial class InputResource
{
    public Task<C> SearchAsync(double limit, RequestOptions? options = null, CancellationToken cancellationToken = default) => Call(limit, options);
}
`

describe("the v1 C# SDK within the budget (bit 15, G13)", () => {
	it("reads each class's operation signature with its body stripped, keyed Class.method, the resource classes too", () => {
		expect(Object.fromEntries(v1CSharpSdkSurfaces(CS_CLIENT))).toEqual({
			"HoneySdkClient.GetAAsync":
				"public Task<SdkResult<A>> GetAAsync(string id, RequestOptions? options = null, CancellationToken cancellationToken = default)",
			"HoneySdkClient.ListAsync":
				"public Task<B> ListAsync(RequestOptions? options = null, CancellationToken cancellationToken = default)",
			"InputResource.SearchAsync":
				"public Task<C> SearchAsync(double limit, RequestOptions? options = null, CancellationToken cancellationToken = default)",
		})
	})

	it("refuses a signature that spans lines, so a formatted client never measures short", () => {
		const wrapped = CS_CLIENT.replace(
			"ListAsync(RequestOptions? options = null, CancellationToken",
			"ListAsync(RequestOptions? options = null,\n        CancellationToken",
		)
		expect(() => v1CSharpSdkSurfaces(wrapped)).toThrow("HoneySdkClient.ListAsync spans lines")
	})

	it(`keeps every e2e app's C# operations within ${CSHARP_SDK_CEILING} tokens, in both throwOnError modes`, () => {
		const over: string[] = []
		for (const app of APPS) {
			const spec = appSpec(app)
			for (const throwOnError of [true, false]) {
				const surfaces = v1CSharpSdkSurfaces(generateCSharpSdk(spec, { throwOnError }).files["Client.cs"] ?? "")
				/* completeness: a surface the reader misses can never pass by going unmeasured */
				const plans = Object.keys(csharpCallPlans(spec, { throwOnError })).length
				if (surfaces.size !== plans) over.push(`${app}: ${surfaces.size} of ${plans} measured`)
				for (const [key, text] of surfaces) {
					const tokens = countTokens(text)
					if (tokens > CSHARP_SDK_CEILING) over.push(`${app}/${key}${throwOnError ? "" : " (safe)"}: ${tokens}`)
				}
			}
		}
		expect(over).toEqual([])
	})
})

describe("runtimeBytes", () => {
	it("counts bytes on disk, never string length, of the files with its extension, holding every other file apart", () => {
		const dir = runtimeDir("rust")
		const { bytes, names, others } = runtimeBytes(dir, ".rs")
		const length = names.reduce((sum, name) => sum + readFileSync(join(dir, name), "utf8").length, 0)
		const onDisk = names.reduce((sum, name) => sum + readFileSync(join(dir, name)).byteLength, 0)
		expect({ bytes, multiByte: bytes > length, others }).toEqual({
			bytes: onDisk,
			multiByte: true,
			others: ["Cargo.lock"],
		})
	})
})

/*
 * G14 (bit 12): the vendored Go runtime's bloat guard, in bytes on disk as shipped (00-rules:160),
 * never string length (errors.go and stale.go hold multi-byte characters). v0's client-go/* was
 * 77,086 B; +15% gave the original 88,649 gate. Bit 12 phases d and e re-baselined it to 90,000 for
 * named feature bytes: the realtime dial honoring ctx (+113), openChain's ctx check (+186), a fresh
 * X-Request-Id per dial (+450), SSE-open OnResponse/OnLog parity (+851; net +193 after the shared
 * exchange -658 and the shared hook loop -25), the ResumableConnection.Close race fix (+232), the
 * close-code godoc pointer (+95), and a benign WebSocket Close after a server close (+100). No
 * runtime file goes unshipped (dead code). A future raise names its feature bytes and cuts dead and
 * duplicate code first; it is never silent. Bit 19 b2, +958 B on the measured 89,964 to 90,922 B: an SSE stream's
 * open bounded by the call's timeout up to its headers (stream.go +578: the timer, the cancel cause and the body that
 * releases it; request.go +11: wrapTransportError reads context.Cause), and the realtime dials reading the client's
 * current token (transport.go +300: headersOf; realtime.go +72; transport_longpoll.go -6; config.go +3). Bit 19 b3,
 * +73 B to 90,995 B: config.go's sentence that a caller Transport's own headers are the caller's and reach every hop.
 * Bit 19 d1, +1,260 B to 92,255 B: an empty map parameter sends nothing (query.go +57), and a 20 s WebSocket keepalive
 * with a pong deadline, one helper for the raw socket and the realtime transport (ws.go +778, transport.go +232,
 * config.go +127: WSKeepalive, realtime.go +66). Bit 19 d2, +343 B to 92,598 B: HTTP/1.1 pinned on the SDK's own
 * transport, its ALPN list narrowed (redirect.go +413), and the error text without the reason phrase (errors.go -70).
 * Bit 19 e, +3,057 B to 95,655 B: a realtime refusal is terminal only when every transport refused (+570: a drop by
 * refusal ends it, the upgrade's status a typed error), the most specific refusal its error (+194: refusalRank), a
 * 401's one refresh per open restarting the chain (+573), the client's OnRequest and OnResponse on each SSE dial and
 * poll (+1,483: hooked, heard), +237 of comments (realtime_loop.go +1,048, transport.go +1,265, realtime.go +240,
 * transport_longpoll.go +291, transport_sse.go +213); the unreachable "no transports configured" error cut (-58).
 */
const GO_RUNTIME_BYTES = 95_655

describe("the Go runtime within its byte budget (bit 12, G14)", () => {
	it(`ships every runtime file it holds, all of them within ${GO_RUNTIME_BYTES} bytes`, () => {
		const { bytes, names } = runtimeBytes(runtimeDir("go"), ".go")
		expect({ names, over: Math.max(0, bytes - GO_RUNTIME_BYTES) }).toEqual({
			names: runtimeFileNames({ realtime: true, ws: true }),
			over: 0,
		})
	})
})

/*
 * G14 (bit 13): the vendored Rust runtime's bloat guard, in bytes on disk as shipped (00-rules:160), never
 * string length. v0's client-rust/* was 118,498 B (10 files, its sync pair since cut); +15% = 136,273. Counted:
 * the 27 runtime .rs files (129,030 B at bit 13's close). Not counted: the Cargo.lock template (43,185 B),
 * which runtimeFiles() hands sdk.ts to cut each crate's lock from: cargo's dependency manifest, not runtime
 * code, and absent from v0's baseline (honey-a8's ruling). It is the one other file the directory holds. No
 * runtime file goes unshipped (dead code). A raise names its feature bytes and cuts dead and duplicate code
 * first; it is never silent.
 */
const RUST_RUNTIME_BYTES = 136_273

describe("the Rust runtime within its byte budget (bit 13, G14)", () => {
	it(`ships every runtime file it holds, all of them within ${RUST_RUNTIME_BYTES} bytes, the lock template aside`, () => {
		const { bytes, names, others } = runtimeBytes(runtimeDir("rust"), ".rs")
		expect({ names, others, over: Math.max(0, bytes - RUST_RUNTIME_BYTES) }).toEqual({
			names: rustRuntimeFileNames({ realtime: true, ws: true }),
			others: ["Cargo.lock"],
			over: 0,
		})
	})
})

/*
 * G14 (bit 14): the vendored Python runtime's bloat guard, in bytes on disk as shipped (00-rules:160), never
 * string length. v0's client-python/*.py was 74,271 B (7 files; its sync-only 8,352 B included); +15% = 85,412.
 * Counted: the 25 runtime .py files (85,372 B at bit 14's phase e: phase d cut every private-helper docstring,
 * 5,839 B, to fit; phase e's case-insensitive header fold added 178 B). The directory holds nothing else. No
 * runtime file goes unshipped (dead code). A raise names its feature bytes and cuts dead and duplicate code
 * first; it is never silent. Bit 19 b1, +280 over the gate to 85,692 B: exchange.py +320, the header check
 * (a non-token name and any control but tab in a value refused as ConfigError naming the header; it was CR/LF/NUL
 * only, so \u0001 and DEL went out), the token and control patterns and `import re` its only bytes. Bit 19 b2,
 * +291 B to 85,983 B: an event stream's open bounded by the call's timeout up to its headers (send_async.py +270,
 * the wait_for; config.py +21). Bit 19 d1, +432 B to 86,415 B: last_event_id reports the last delivered event
 * (events.py +99), and the WebSocket keepalive made configurable (ws.py +197, config.py +136: ws_keepalive). Bit 19
 * d2, +228 B to 86,643 B: the call's clock starts at request_start (log.py +270: started(); each send file -21).
 * Bit 19 e, +1,788 B to 88,431 B: a realtime refusal is terminal only when every transport refused (+66), the most
 * specific refusal its error (+395: WEIGHTS, weight()), a 401's one refresh per open through the client's guard,
 * restarting the chain (+1,126: the adapters' refresh(), Exchange(refreshes=False)), +201 of comments (realtime.py
 * +919, transport.py +429, transport_ws.py +171, transport_sse.py +171, exchange.py +98).
 */
const PYTHON_RUNTIME_BYTES = 88_431

describe("the Python runtime within its byte budget (bit 14, G14)", () => {
	it(`ships every runtime file it holds, all of them within ${PYTHON_RUNTIME_BYTES} bytes, nothing else beside them`, () => {
		const { bytes, names, others } = runtimeBytes(runtimeDir("python"), ".py")
		expect({ names, others, over: Math.max(0, bytes - PYTHON_RUNTIME_BYTES) }).toEqual({
			names: pythonRuntimeFileNames({ realtime: true, ws: true }),
			others: [],
			over: 0,
		})
	})
})

/*
 * G14 (bit 15): the vendored C# runtime's bloat guard, in bytes on disk as shipped (00-rules:160), never string
 * length. Measured at phase d (contract 50 Fd10), replacing the provisional 110,000 B: 129,722 B in 29 files. Fd10's
 * cuts came first: no dead member (the unused-member analyzers flag only ClientConfig.PrintMembers, which the record's
 * ToString calls, and every internal member has a use); every /// block on a non-public member, 14,523 B (13,100 B in
 * phase c's 18 files, 1,423 B in Sse, Wire and WsDial); the loop's header comment, 483 B. By file: Adapters 7,436,
 * Auth 1,655, Body 4,702, Config 7,966, Envelope 5,389, Errors 7,083, Events 6,197, Exchange 9,257, Handler 3,469,
 * Hooks 4,855, Invalidation 3,628, Json 5,638, Log 1,703, Operation 1,482, Path 2,003, Query 1,986, Realtime 5,127,
 * RealtimeLoop 6,436, Redirect 2,165, Result 1,273, Sse 3,789, Stale 4,527, Transport 6,319, TransportLongPoll 2,226,
 * TransportSse 2,137, TransportWs 1,550, Wire 3,289, Ws 10,774, WsDial 5,790. Phase d's delta on phase c's 88,583 B,
 * +41,139 B: SSE core (Events, Sse, Wire) 13,275 B, WebSocket (Ws, WsDial) 16,564 B, realtime (Adapters, Realtime,
 * RealtimeLoop and the three transports) 24,912 B, phase c's 18 files -13,612 B (the cut, Wire's move out of
 * Exchange, the stream path's growth). It is 692 B over Rust's 129,030 B: Ws holds 1,936 B of public docs and the
 * end's lock and once-only cancel, WsDial the dial's own deadline and status mapping (no exchange, ruled) and the
 * Upgrade check Q-d1's probe found the BCL never makes, Adapters 1,520 B of public docs on the interfaces, options
 * and kinds. Counted: every runtime .cs file; the directory holds nothing else. No runtime file goes unshipped (dead
 * code). A raise names its feature bytes and cuts dead and duplicate code first; it is never silent. Phase e, +129 B
 * to 129,851 B (Fe7): Log's clock starts at request_start, which logs 0, and every later entry passes its elapsed
 * time (Q-e4: the clock read from construction logged request_start at up to 54 ms on a cold first call under load);
 * Log has no dead member to cut.
 */
/*
 * Bit 19 b1, +756 B to 130,607 B: the header check every request and WebSocket dial passes (Wire.Check: a non-token
 * name or a control but tab in a value refused as ConfigException naming the header; a bad name was silently
 * dropped by TryAddWithoutValidation and \u0001 and DEL went out raw). Wire.cs +939 (the check and its token set),
 * Exchange.cs -212 (its CR/LF/NUL loop cut: Wire.Check covers it), WsDial.cs +29 (the dial's call).
 * Bit 19 e, +2,983 B to 133,590 B: a realtime refusal is terminal only when every transport refused, a lazy long-poll's
 * first read included (+628), the most specific refusal its error (+391: Rank), a 401's one refresh per open
 * restarting the chain (+1,538: IDialed, Dial's RefreshAsync and used token, the exchange's refreshes flag), +426 of
 * comments (RealtimeLoop.cs +2,451, Adapters.cs +370, Exchange.cs +36, each transport +42); a dead `_refused` reset
 * and a dead try/catch cut.
 */
const CSHARP_RUNTIME_BYTES = 133_590

describe("the C# runtime within its byte budget (bit 15, G14)", () => {
	it(`ships every runtime file it holds, all of them within ${CSHARP_RUNTIME_BYTES} bytes, nothing else beside them`, async () => {
		const { runtimeFileNames: csharpRuntimeFileNames } = await import("../src/emit/csharp/transport.ts")
		const { bytes, names, others } = runtimeBytes(runtimeDir("csharp"), ".cs")
		expect({ names, others, over: Math.max(0, bytes - CSHARP_RUNTIME_BYTES) }).toEqual({
			names: csharpRuntimeFileNames({ realtime: true, ws: true }),
			others: [],
			over: 0,
		})
	})
})

/*
 * G14 (bit 11): the vendored TS runtime's bloat guard, in bytes on disk as shipped (00-rules:160), never string length,
 * locked at its measured bytes. 105,547 B → 108,041 B, +2,494 B: the bounded body read (response.ts +2,252, config.ts
 * +296, http.ts -54), every body read in its chunks and refused past maxResponseBytes, the bit 11/18 response cap.
 * Bit 19 b1, +740 B to 108,781 B: the header check (headerValue: a non-token name or a control but tab in a value
 * refused as a TypeError naming the header, before Node's Headers can quote the value or Bun send it raw), in
 * request.ts's headersOf, which the header assembly moved into: request.ts +1,354, http.ts -614. Bit 19 b2, +343 B
 * to 109,124 B: an explicit stream's open bounded by the call's timeout up to its headers (http.ts +72, config.ts
 * +15), and a resumable connection's headers read on each dial (realtime-connection.ts +289; realtime.ts -33, its
 * dead `token` and `onAuthExpired` options cut). Bit 19 b3, +437 B to 109,561 B: the auth header pair defaulting to
 * the API's scheme by the siblings' pair rule (sdk.ts +338: schemeAuth; http.ts +51: no prefix under a caller's name;
 * config.ts +48). Bit 19 d1, +354 B to 109,915 B: realtime WebSocket keepalive on by default at 20 s, its dead
 * wait twice the interval (realtime.ts +532: keepaliveOf; realtime-connection.ts -178). Bit 19 d2, +973 B to 110,888 B:
 * the event stream's caps in UTF-8 bytes, a line's and an event's, complete lines included (sse.ts +790, config.ts +113:
 * sseMaxLineBytes and sseMaxEventBytes for sseMaxBufferChars, http.ts +40), and `HTTP <status>: ` before a server
 * message (response.ts +30). Bit 19 e, +754 B to 111,642 B: a resumable connection's refusal is terminal only when every
 * transport refused, a drop by refusal included (+245: refused, #refuse), the most specific refusal its error (+240:
 * RANK, walkChain's pick), the chain moved into walkChain (+139), +130 of comments (realtime.ts +782,
 * realtime-connection.ts -28); RealtimeAuthError, which nothing threw, and #open's dead all_failed fallback cut (-186).
 * Bit 19 e2, +7,592 B to 119,234 B: an x-realtime op is one resumable connection over WebSocket, SSE and long-poll
 * (realtime-transports.ts +5,887, new): the WebSocket adapter with no credential, a failure before open the lowest
 * refusal (+1,093), the SSE adapter (+808), the long-poll adapter with its 204 re-poll (+754), their shared HTTP
 * connection and POSTed send (+646), the frames synthesized from bare payloads (+932), the string cursor (+395), the
 * client's one refresh per open behind a symbol key (+677), the SDK's dispatch and ResumableConnection<T> (+1,177),
 * +1,110 of one-line comments (http.ts +455, sdk.ts +420, realtime.ts +496, realtime-connection.ts +334).
 * Counted: every runtime .ts file, each one RUNTIME_MODULES joins; the directory holds nothing else. A raise names its
 * feature bytes and cuts dead and duplicate code first; it is never silent.
 */
const TS_RUNTIME_BYTES = 119_234

describe("the TS runtime within its byte budget (bit 11, G14)", () => {
	it(`ships every runtime file it holds, all of them within ${TS_RUNTIME_BYTES} bytes, nothing else beside them`, () => {
		const { bytes, names, others } = runtimeBytes(runtimeDir("ts"), ".ts")
		expect({ names, others, over: Math.max(0, bytes - TS_RUNTIME_BYTES) }).toEqual({
			names: RUNTIME_MODULES.map((name) => `${name}.ts`).sort(),
			others: [],
			over: 0,
		})
	})
})
