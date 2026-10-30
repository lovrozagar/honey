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
	BUDGET_APPS,
	budgetSpec,
	measuredSurfaces,
	overCeiling,
	peakSurface,
	runtimeBytes,
	v1CSharpSdkSurfaces,
	v1GoSdkSurfaces,
	v1PythonSdkSurfaces,
	v1RustSdkSurfaces,
	v1SdkSurfaces,
} from "./sdk-budget.ts"
import { SPAWN_TIMEOUT } from "../src/gen/__fixtures__/spawn-timeout.ts"

const REPO = resolve(import.meta.dirname, "../../..")
const APPS = BUDGET_APPS
const appSpec = budgetSpec
/** A vendored runtime's directory. */
const runtimeDir = (language: string) => join(REPO, `packages/gen/src/runtime/${language}`)
/** The headroom every G13 ceiling leaves over its measured max. */
const HEADROOM = 0.2

/* each language's reader, by app: what `measuredSurfaces` measures once for its ceiling leg and its max leg alike */
const readTs = (app: string) => {
	const { files, stem } = generateSdk(appSpec(app), { name: "SDK" })
	return { surfaces: v1SdkSurfaces(files[`${stem}.types.gen.ts`] ?? "") }
}
const readGo = (app: string) => {
	const spec = appSpec(app)
	const options = { modulePath: "example.com/budget" }
	return {
		plans: Object.keys(goCallPlans(spec, options)).length,
		surfaces: v1GoSdkSurfaces(generateGoSdk(spec, options).files["client.go"] ?? ""),
	}
}
const readRust = (app: string) => {
	const spec = appSpec(app)
	return {
		plans: Object.keys(rustCallPlans(spec)).length,
		surfaces: v1RustSdkSurfaces(generateRustSdk(spec).files["src/client.rs"] ?? ""),
	}
}
const readPython = (app: string) => {
	const spec = appSpec(app)
	return {
		plans: Object.keys(pythonCallPlans(spec)).length,
		surfaces: v1PythonSdkSurfaces(generatePythonSdk(spec).files["src/honey_sdk/client.py"] ?? ""),
	}
}
const readCSharp = (app: string) => {
	const spec = appSpec(app)
	return {
		plans: Object.keys(csharpCallPlans(spec)).length,
		surfaces: v1CSharpSdkSurfaces(generateCSharpSdk(spec).files["Client.cs"] ?? ""),
	}
}

describe("the v1 SDK within the budget (bit 11)", () => {
	it("reads each operation's member line, a call, a stream or a connection, a repeated name numbered", () => {
		const types = `interface Ops {\n\titems: {\n\t\tget: HoneyCall<A, R>\n\t\tfeed: HoneyStream<{}, SSEEvent>\n\t}\n\tusers: {\n\t\tget: HoneyCall<B, S, { 404: E }>\n\t}\n\t"x-y"(input?: C): TypedWebSocket\n\tsafe: {\n\t}\n}`
		expect(Object.fromEntries(v1SdkSurfaces(types))).toEqual({
			'"x-y"': '"x-y"(input?: C): TypedWebSocket',
			feed: "feed: HoneyStream<{}, SSEEvent>",
			get: "get: HoneyCall<A, R>",
			"get#2": "get: HoneyCall<B, S, { 404: E }>",
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
 * G13 (bit 21 i1): TS's own per-operation ceiling, not sdkCli's 234. Measured over the five e2e apps' 71 surfaces
 * (`v1SdkSurfaces`: each operation's one member line, `HoneyCall<…>` or `HoneyStream<…>`, which types its raw
 * overload, its value and its safe twin's Result alike): max 81 (kitchen, SDK.postApiV1Organizations), sum 2,694; at
 * 425f0a4 the two overload lines measured max 162, sum 5,258. 81 + 20% headroom = 98. An operation over it is fixed
 * in the schema, never by raising the ceiling.
 */
const TS_SDK_CEILING = ceilingOf([81], HEADROOM)

describe("the TS SDK within its own budget (bit 21 i1, G13)", () => {
	it(`keeps every e2e app's TS operations within ${TS_SDK_CEILING} tokens, each measured once for both styles`, () => {
		const measured = measuredSurfaces("ts", readTs)
		expect({
			ceiling: TS_SDK_CEILING,
			over: overCeiling(measured, TS_SDK_CEILING),
			surfaces: measured.tokens.size,
		}).toEqual({ ceiling: 98, over: [], surfaces: 71 })
	})

	/* the ceiling's own input, so a surface that shrinks brings the ceiling down instead of leaving stale headroom */
	it("measures its largest surface where its ceiling comes from", () => {
		const { at, tokens } = peakSurface(measuredSurfaces("ts", readTs))
		expect({ at, ceiling: TS_SDK_CEILING, derived: ceilingOf([tokens], HEADROOM), tokens }).toEqual({
			at: "kitchen/postApiV1Organizations",
			ceiling: 98,
			derived: 98,
			tokens: 81,
		})
	})
})

/*
 * G13 (bit 12, re-set bit 21 i3): Go's own per-operation ceiling, not sdkCli's 234. Measured over the five e2e apps'
 * 71 operations (`v1GoSdkSurfaces` over the pre-gofmt client.go: each operation's signature, its Client.Safe() twin's
 * field and the Opts block both take, as one surface, since both styles are always emitted): max 114 (surface,
 * GetInParamsMembersByOrgIdAndMemberId: 58 the signature, 41 the twin's field, 15 the Opts), median 65, min 49, sum
 * 4,764. A twin as a method restating the signature measured max 134, sum 6,002; the field over a generic
 * Call<n>/Stream<n>/Conn<n> spells its types once. At 7d80509 the surface was one signature per throwOnError mode
 * (142 surfaces): max 78 (surface, PutInAllByResourceId, safe mode), median 45, sum 6,515; its ceiling was 94.
 * 114 + 20% headroom = 137. Each language holds its own ceiling, set from its own measurement. An
 * operation over it is fixed in the schema, never by raising the ceiling; revisit only for a genuinely large,
 * legitimate operation.
 */
const GO_SDK_CEILING = ceilingOf([114], HEADROOM)

const GO_CLIENT = `package sdk

// Get calls GET /a.
func (r *Client) Get(ctx context.Context, opts *GetOpts, reqOpts ...RequestOption) (*A, error) {
\treturn get(ctx)
}

func (r *ItemsResource) Get(ctx context.Context, id string, reqOpts ...RequestOption) error {
\treturn nil
}

func (r *Client) helper(x int) {
}

// SafeClient is Client answering as Client.Safe() does: each method a field of its name.
type SafeClient struct {
\tGet Call2[context.Context, *GetOpts, *A]
\tItems *SafeItemsResource
}

// SafeItemsResource is ItemsResource answering as Client.Safe() does: each method a field of its name.
type SafeItemsResource struct {
\tGet Call2[context.Context, string, struct{}]
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
	it("reads each method's signature, its Safe() twin's field and its Opts block as one surface, keyed receiver.method", () => {
		expect(Object.fromEntries(v1GoSdkSurfaces(GO_CLIENT))).toEqual({
			"Client.Get": [
				"func (r *Client) Get(ctx context.Context, opts *GetOpts, reqOpts ...RequestOption) (*A, error)",
				"Get Call2[context.Context, *GetOpts, *A]",
				"type GetOpts struct {",
				"\t// Limit caps the page.",
				"\tLimit *int",
				"}",
			].join("\n"),
			"ItemsResource.Get": [
				"func (r *ItemsResource) Get(ctx context.Context, id string, reqOpts ...RequestOption) error",
				"Get Call2[context.Context, string, struct{}]",
			].join("\n"),
		})
	})

	it("refuses a method whose Opts struct is never declared, or that has no Safe() twin, so none measures short", () => {
		const undeclared = GO_CLIENT.replace("type GetOpts struct", "type OtherOpts struct")
		const untwinned = GO_CLIENT.replace(
			"\tGet Call2[context.Context, string, struct{}]",
			"\tGot Call2[context.Context, string, struct{}]",
		)
		expect(() => v1GoSdkSurfaces(undeclared)).toThrow("Client.Get takes GetOpts, which is never declared")
		expect(() => v1GoSdkSurfaces(untwinned)).toThrow("ItemsResource.Get has no Client.Safe() twin")
	})

	it(`keeps every e2e app's Go operations within ${GO_SDK_CEILING} tokens, each measured once for both styles`, () => {
		const measured = measuredSurfaces("go", readGo)
		expect({
			ceiling: GO_SDK_CEILING,
			over: overCeiling(measured, GO_SDK_CEILING),
			surfaces: measured.tokens.size,
		}).toEqual({ ceiling: 137, over: [], surfaces: 71 })
	})

	it("measures its largest surface where its ceiling comes from", () => {
		const { at, tokens } = peakSurface(measuredSurfaces("go", readGo))
		expect({ at, ceiling: GO_SDK_CEILING, derived: ceilingOf([tokens], HEADROOM), tokens }).toEqual({
			at: "surface/Client.GetInParamsMembersByOrgIdAndMemberId",
			ceiling: 137,
			derived: 137,
			tokens: 114,
		})
	})
})

/*
 * G13 (bit 13): Rust's own per-operation ceiling, not sdkCli's 234 nor Go's 94 (137 since bit 21 i3). Measured at bit
 * 13 over the five e2e apps in both throwOnError modes: max 80 (put_in_all_by_resource_id, safe mode), 80 + 20% = 96.
 * Bit 21 i4 (R-i5): both styles are one signature, the method generic over the client's style (`Call<T, S>`, the
 * same method on `client.safe()`), so the surface is that signature with its Opts block. Measured over the five apps'
 * 71 operations (`v1RustSdkSurfaces` over the pre-rustfmt src/client.rs): max 79 (surface,
 * Client.put_in_all_by_resource_id), median 37, min 26, sum 2,876; at 7a6eb5e 142 surfaces (one per mode), max 80,
 * median 38, sum 5,775. 79 + 20% headroom = 95. Each language holds its own ceiling, set from its own measurement.
 * An operation over it is fixed in the schema, never by raising the ceiling; revisit only for a genuinely large,
 * legitimate operation.
 */
const RUST_SDK_CEILING = ceilingOf([79], HEADROOM)

const RUST_CLIENT = `// @generated by honey. DO NOT EDIT.
//! The client, its resources and their operations.

use crate::*;

impl Client {
    /// The client for \`config\`.
    pub fn new(config: ClientConfig) -> Result<Client, Error> {
        Client::build(config, crate::config::Defaults { base_url: None })
    }
}

impl<S: Style> Client<S> {
    pub fn items(&self) -> ItemsResource<'_, S> {
        ItemsResource { client: self }
    }

    /// Sends \`GET /a\`.
    #[allow(clippy::too_many_arguments)]
    pub fn get(&self, id: &str, opts: &GetOpts) -> Call<A, S> {
        Call::new(self, spec, crate::answer::json::<A>)
    }
}

impl<'a, S: Style> ItemsResource<'a, S> {
    pub fn get(&self, _opts: &ItemsGetOpts) -> Call<(), S> {
        Call::new(self.client, spec, crate::answer::none)
    }

    pub fn r#type(&self, body: Item, _opts: &ItemsGetOpts) -> Call<Item, S, ItemsTypeHeaders> {
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
				"pub fn get(&self, id: &str, opts: &GetOpts) -> Call<A, S>",
				"pub struct GetOpts {",
				"    /// Required by the API.",
				"    pub limit: i64,",
				"    pub cursor: Option<String>,",
				"}",
			].join("\n"),
			"ItemsResource.get": "pub fn get(&self, _opts: &ItemsGetOpts) -> Call<(), S>\npub struct ItemsGetOpts {}",
			"ItemsResource.r#type":
				"pub fn r#type(&self, body: Item, _opts: &ItemsGetOpts) -> Call<Item, S, ItemsTypeHeaders>\npub struct ItemsGetOpts {}",
		})
	})

	it("refuses a method whose Opts is never declared, or that names none, so a missed block never measures short", () => {
		const renamed = RUST_CLIENT.replace("pub struct GetOpts {", "pub struct OtherOpts {")
		expect(() => v1RustSdkSurfaces(renamed)).toThrow("Client.get takes GetOpts, which is never declared")
		const unnamed = RUST_CLIENT.replace("_opts: &ItemsGetOpts) -> Call<(), S>", "_opts: &()) -> Call<(), S>")
		expect(() => v1RustSdkSurfaces(unnamed)).toThrow("ItemsResource.get takes no Opts")
	})

	it(`keeps every e2e app's Rust operations within ${RUST_SDK_CEILING} tokens, the one signature both styles call`, () => {
		const measured = measuredSurfaces("rust", readRust)
		expect({
			ceiling: RUST_SDK_CEILING,
			over: overCeiling(measured, RUST_SDK_CEILING),
			surfaces: measured.tokens.size,
		}).toEqual({ ceiling: 95, over: [], surfaces: 71 })
	})

	it("measures its largest surface where its ceiling comes from", () => {
		const { at, tokens } = peakSurface(measuredSurfaces("rust", readRust))
		expect({ at, ceiling: RUST_SDK_CEILING, derived: ceilingOf([tokens], HEADROOM), tokens }).toEqual({
			at: "surface/Client.put_in_all_by_resource_id",
			ceiling: 95,
			derived: 95,
			tokens: 79,
		})
	})
})

/*
 * G13 (bit 14): Python's own per-operation ceiling, not sdkCli's 234 nor Go's 94 (137 since bit 21 i3) or Rust's 96 (95 since bit 21 i4). Bit 21 i2 (R-i5, the
 * G13 pattern): a surface is both styles, the AsyncSDK signature and its `client.safe` twin's one line
 * (`v1PythonSdkSurfaces` over the pre-format client.py). Measured over the five e2e apps' 71 operations (71
 * surfaces): max 75 (surface, AsyncSDK.put_in_all_by_resource_id), median 42, min 30 (compose,
 * AsyncSDK.get_account), sum 3,005. At 758e89d the surface was one signature per throwOnError mode (142 surfaces,
 * max 59 there in safe mode, sum 4,148), so its ceiling of 71 (59 + 20%) measured another text and is replaced:
 * 75 + 20% headroom = 90. Each language holds its own ceiling, set from its own measurement. An operation over it is
 * fixed in the schema, never by raising the ceiling; revisit only for a genuinely large, legitimate operation.
 */
const PYTHON_SDK_CEILING = ceilingOf([75], HEADROOM)

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


class SafeUsersResource:
    get = Safe.of_sync(UsersResource.get)


class AsyncSafeUsersResource:
    get = Safe.of(AsyncUsersResource.get)


class AsyncSafeSDK:
    list = Safe.of(AsyncSDK.list)
`

describe("the v1 Python SDK within the budget (bit 14, G13)", () => {
	it("reads each async operation's signature line with its client.safe twin, keyed class.method, never the sync twin or a lifecycle method", () => {
		expect(Object.fromEntries(v1PythonSdkSurfaces(PY_CLIENT))).toEqual({
			"AsyncSDK.list":
				"async def list(self, *, limit: int | None = None, options: RequestOptions | None = None) -> _builtins.list[User]\nlist = Safe.of(AsyncSDK.list)",
			"AsyncUsersResource.get":
				"async def get(self, id: str, *, options: RequestOptions | None = None) -> User\nget = Safe.of(AsyncUsersResource.get)",
		})
	})

	it("refuses an operation without its client.safe twin, so a dropped twin never measures short", () => {
		const untwinned = PY_CLIENT.replace("    list = Safe.of(AsyncSDK.list)\n", "")
		expect(() => v1PythonSdkSurfaces(untwinned)).toThrow("AsyncSDK.list has no client.safe twin")
	})

	it("refuses a signature that spans lines, so a formatted client never measures short", () => {
		const wrapped = PY_CLIENT.replace(
			"    async def get(self, id: str, *, options",
			"    async def get(\n        self, id: str, *, options",
		)
		expect(() => v1PythonSdkSurfaces(wrapped)).toThrow("AsyncUsersResource.get spans lines")
	})

	it(`keeps every e2e app's Python operations within ${PYTHON_SDK_CEILING} tokens, both styles together`, () => {
		const measured = measuredSurfaces("python", readPython)
		expect({
			ceiling: PYTHON_SDK_CEILING,
			over: overCeiling(measured, PYTHON_SDK_CEILING),
			surfaces: measured.tokens.size,
		}).toEqual({ ceiling: 90, over: [], surfaces: 71 })
	})

	it("measures its largest surface where its ceiling comes from", () => {
		const { at, tokens } = peakSurface(measuredSurfaces("python", readPython))
		expect({ at, ceiling: PYTHON_SDK_CEILING, derived: ceilingOf([tokens], HEADROOM), tokens }).toEqual({
			at: "surface/AsyncSDK.put_in_all_by_resource_id",
			ceiling: 90,
			derived: 90,
			tokens: 75,
		})
	})
})

/*
 * G13 (bit 15): C#'s own per-operation ceiling, not sdkCli's 234 nor Go's 94 (137 since bit 21 i3), Rust's 96 (95 since bit 21 i4) or Python's 71 (90 since bit 21 i2). Each
 * language holds its own ceiling, set from its own measurement. An operation over it is fixed in the schema, never by
 * raising the ceiling; revisit only for a genuinely large, legitimate operation. The emitter writes no formatter pass,
 * so the measured text is the shipped text. Bit 15 measured one signature per throwOnError mode (144 surfaces): max
 * 56 (surface, PutInAllByResourceId, safe mode), 56 + 20% = 68. Bit 21 i5 (R-i5): an operation's surface is both
 * styles, its signature and its `client.Safe` twin's (`v1CSharpSdkSurfaces`), measured over the five e2e apps' 71
 * operations: max 107 (surface/HoneySdkClient.PutInAllByResourceIdAsync: the normal signature 53, the twin 54), median
 * 54, min 40, sum 4,149; at 570d7cd the 142 one-mode surfaces summed 4,261 (max 56, median 28). C# has no associated
 * type, so Rust's one style-generic signature (56 at most) is CS0704, and Go's delegate field (86) loses a spec param's
 * name (CS1746 on a named argument): the restated twin is the cheapest form that keeps the normal call's arguments.
 * 107 + 20% = 129.
 */
const CSHARP_SDK_CEILING = ceilingOf([107], HEADROOM)

const CS_CLIENT = `namespace Acme;

public sealed class HoneySdkClient
{
    public Task<A> GetAAsync(string id, RequestOptions? options = null, CancellationToken cancellationToken = default) => Call(id, options);
    public Task<B> ListAsync(RequestOptions? options = null, CancellationToken cancellationToken = default)
    {
        return Call(options);
    }
}

public sealed partial class InputResource
{
    public Task<C> SearchAsync(double limit, RequestOptions? options = null, CancellationToken cancellationToken = default) => Call(limit, options);
}

/// <summary><see cref="HoneySdkClient"/>'s safe mirror: each method answers a <c>Result</c>.</summary>
public sealed class SafeHoneySdkClient
{
    public Task<Result<A>> GetAAsync(string id, RequestOptions? options = null, CancellationToken cancellationToken = default) => Safe(id, options);
    public Task<Result<B>> ListAsync(RequestOptions? options = null, CancellationToken cancellationToken = default) => Safe(options);
}

/// <summary><see cref="InputResource"/>'s safe mirror: each method answers a <c>Result</c>.</summary>
public sealed class SafeInputResource
{
    public Task<Result<C>> SearchAsync(double limit, RequestOptions? options = null, CancellationToken cancellationToken = default) => Safe(limit, options);
}
`

/** A C# signature's client.Safe twin: the same parameters, a Result of its answer. */
const twin = (normal: string) => normal.replace(/^public Task<(\w+)>/, "public Task<Result<$1>>")

describe("the v1 C# SDK within the budget (bit 15, G13)", () => {
	it("reads each operation's signature and its client.Safe twin's, bodies stripped, keyed Class.method, the resource classes too", () => {
		const get =
			"public Task<A> GetAAsync(string id, RequestOptions? options = null, CancellationToken cancellationToken = default)"
		const list =
			"public Task<B> ListAsync(RequestOptions? options = null, CancellationToken cancellationToken = default)"
		const search =
			"public Task<C> SearchAsync(double limit, RequestOptions? options = null, CancellationToken cancellationToken = default)"
		expect(Object.fromEntries(v1CSharpSdkSurfaces(CS_CLIENT))).toEqual({
			"HoneySdkClient.GetAAsync": `${get}\n${twin(get)}`,
			"HoneySdkClient.ListAsync": `${list}\n${twin(list)}`,
			"InputResource.SearchAsync": `${search}\n${twin(search)}`,
		})
	})

	it("refuses a signature that spans lines, so a formatted client never measures short", () => {
		const wrapped = CS_CLIENT.replace(
			"ListAsync(RequestOptions? options = null, CancellationToken",
			"ListAsync(RequestOptions? options = null,\n        CancellationToken",
		)
		expect(() => v1CSharpSdkSurfaces(wrapped)).toThrow("HoneySdkClient.ListAsync spans lines")
	})

	it("refuses an operation its client.Safe mirror drops, so a missing twin never measures short", () => {
		const dropped = CS_CLIENT.replace(/^ {4}public Task<Result<C>> SearchAsync.*\n/m, "")
		expect(() => v1CSharpSdkSurfaces(dropped)).toThrow("InputResource.SearchAsync has no client.Safe twin")
	})

	it(`keeps every e2e app's C# operations within ${CSHARP_SDK_CEILING} tokens, each its two styles' signatures`, () => {
		const measured = measuredSurfaces("csharp", readCSharp)
		expect({
			ceiling: CSHARP_SDK_CEILING,
			over: overCeiling(measured, CSHARP_SDK_CEILING),
			surfaces: measured.tokens.size,
		}).toEqual({ ceiling: 129, over: [], surfaces: 71 })
	})

	it("measures its largest surface where its ceiling comes from", () => {
		const { at, tokens } = peakSurface(measuredSurfaces("csharp", readCSharp))
		expect({ at, ceiling: CSHARP_SDK_CEILING, derived: ceilingOf([tokens], HEADROOM), tokens }).toEqual({
			at: "surface/HoneySdkClient.PutInAllByResourceIdAsync",
			ceiling: 129,
			derived: 129,
			tokens: 107,
		})
	})
})

describe("runtimeBytes", () => {
	it(
		"counts bytes on disk, never string length, of the files with its extension, holding every other file apart",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const dir = runtimeDir("rust")
			const { bytes, names, others } = runtimeBytes(dir, ".rs")
			const length = names.reduce((sum, name) => sum + readFileSync(join(dir, name), "utf8").length, 0)
			const onDisk = names.reduce((sum, name) => sum + readFileSync(join(dir, name)).byteLength, 0)
			expect({ bytes, multiByte: bytes > length, others }).toEqual({
				bytes: onDisk,
				multiByte: true,
				others: ["Cargo.lock"],
			})
		},
	)
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
 * Bit 19 k1, +261 B of doc only, to 95,916 B: sse.go +136 (a range's end, a break included, frees the connection),
 * ws.go +125 (the dial runs no OnRequest or OnResponse hook and no OnAuthExpired refresh).
 * Bit 21 i3, +2,155 B to 98,071 B: the safe mirror and an over-cap answer. Dead code first: a scan for runtime
 * definitions nothing references found only export.go's public Honey* seams (kept); SDKResult with OK (403) and
 * safeResult (568) are cut. result.go +1,202 (Result with Ok 552, DecodeError 417, safeCall and with 356, safeOf 495,
 * safeOpen 343, decodeJSON reading the requestResult; the cuts), stream.go +287 (a safe call's stream opened on the
 * call), sse.go +312 (wireBody: a read failing mid-stream is a call's wrapped no-answer error, not a bare
 * io.ErrUnexpectedEOF), request.go +266 (a body past the cap is an answer: requestResult.over, a 2xx's DecodeError
 * after the stale settle), options.go +88 (the safe call's slot, deliver reporting to it).
 * Bit 21 i7, +1,169 B to 99,240 B: a realtime send over SSE or long-poll POSTs (both were receive-only), answered as
 * a call is, so a 2xx past the cap is its *DecodeError, as in the other five SDKs. Nothing left dead: the two
 * receive-only errors fold into `posted`, the dial's no-answer path is unchanged. realtime.go +633 (newRealtime's
 * send through doRequest, call.sent: the POST, a string as text and any other value as JSON; Send's doc),
 * transport.go +423 (TransportOpts.send, posted), transport_sse.go +64, transport_longpoll.go +49 (each conn's send).
 */
const GO_RUNTIME_BYTES = 99_240

describe("the Go runtime within its byte budget (bit 12, G14)", () => {
	it(`ships every runtime file it holds, their bytes exactly ${GO_RUNTIME_BYTES}`, { timeout: SPAWN_TIMEOUT }, () => {
		const { bytes, names } = runtimeBytes(runtimeDir("go"), ".go")
		expect({ bytes, names }).toEqual({
			bytes: GO_RUNTIME_BYTES,
			names: runtimeFileNames({ realtime: true, ws: true }),
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
 * first; it is never silent. Bit 21 i4, +1,603 over the lock to 137,876 B (+3,060 on 7a6eb5e's 134,816), the safe
 * mirror and the over-cap answer. Cut first: SdkResult (649 B), the safe_* runs, and RequestSpec::duplicate (dead
 * since bit 13, hidden by its impl's allow(dead_code), 536 B). Named: result.rs +2,234 (Answer and SafeError, the
 * sealed Failed and its conversions, Style with Throw and Safe and their settle), call.rs +722 (Call<T, S, H>, each
 * future settled by its style, an undecodable declared header answered), config.rs +566 (Client<S> and safe()),
 * errors.rs +482 (DecodeError, Error::decode), transport.rs +403 (a dial's answer past the cap still no answer),
 * exchange.rs +220 (an answer past the cap read as an answer, its `over` mark), events.rs +67 (an opening status
 * answered); answer.rs -996 (one read path, the over-cap 2xx its decode error), request.rs -536, the call sites of
 * Error::decode -102.
 * Bit 21 i7, +110 B to 137,986 B: transport.rs +110, a realtime send's POST read through answer::none, the one answer
 * path, so its 2xx past the cap is Error::Decode, not a dial's Error::Transport (`ok` still answers the dials).
 */
const RUST_RUNTIME_BYTES = 137_986

describe("the Rust runtime within its byte budget (bit 13, G14)", () => {
	it(
		`ships every runtime file it holds, their bytes exactly ${RUST_RUNTIME_BYTES}, the lock template aside`,
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const { bytes, names, others } = runtimeBytes(runtimeDir("rust"), ".rs")
			expect({ bytes, names, others }).toEqual({
				bytes: RUST_RUNTIME_BYTES,
				names: rustRuntimeFileNames({ realtime: true, ws: true }),
				others: ["Cargo.lock"],
			})
		},
	)
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
 * Bit 19 k1, +245 B of doc only, to 88,676 B: events.py +107 (`async with` or `aclose()` frees the connection, a
 * dropped stream only when collected), ws.py +138 (the dial runs no hook and no on_auth_expired refresh).
 * Then +106 B of doc only, to 88,782 B: ws.py +106 (`async with` or `close()` frees a socket's connection, a dropped
 * socket only when collected).
 * Bit 21 i2, +2,182 B to 90,964 B: the safe mirror's Result and plumbing, and the over-cap answer. Dead code first: a
 * scan for runtime definitions nothing references found only `proven_transport` (public, kept); SDKResult (493 B) is
 * cut. result.py +1,155 (Ok, Err, the Result alias, ANSWERS, and `Safe`: the view mapping call and sse to their safe
 * twins, `of`/`of_sync`/`keep` typing a twin, 1,648 B in all); send_async.py +594 (safe_sse: an error status or an
 * undecodable header at a stream's opening is its Err, sse raising it; result's Ok/Err; the over-cap flag through
 * send and attempt); send_sync.py +106 (result's Ok/Err; the over-cap flag); exchange.py +105 (HttpAnswer.over,
 * limit(), decoded's over-cap DecodeError, read's no-answer raise cut); transport_longpoll.py +149 (a poll past the
 * cap stays no answer: mid-stream, f2); ws.py +73 (a refusal's body past the cap is left unread, its status error
 * kept).
 * Bit 21 i7, +18 B to 90,982 B: transport.py +18, a realtime send's POST read by `decoded` as an answer-less op, so
 * its 2xx past the cap is its DecodeError (before, it was taken; its error status raises as before).
 */
const PYTHON_RUNTIME_BYTES = 90_982

describe("the Python runtime within its byte budget (bit 14, G14)", () => {
	it(
		`ships every runtime file it holds, their bytes exactly ${PYTHON_RUNTIME_BYTES}, nothing else beside them`,
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const { bytes, names, others } = runtimeBytes(runtimeDir("python"), ".py")
			expect({ bytes, names, others }).toEqual({
				bytes: PYTHON_RUNTIME_BYTES,
				names: pythonRuntimeFileNames({ realtime: true, ws: true }),
				others: [],
			})
		},
	)
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
 * Bit 19 k1, +90 B of doc only, to 133,680 B: Ws.cs +126 (the dial runs no OnRequest or OnResponse hook and no
 * OnAuthExpired refresh), then -36 rewording TypedWebSocket's summary to keep Ws.cs within 300 lines.
 * Bit 21 i5, +1,198 B to 134,878 B: the normal client always throws and `client.Safe` answers a Result (R-i2..R-i4),
 * an over-cap 2xx a DecodeException. Cut first: SdkResult and SdkResult<T> (1,273 B) and the five `…ResultAsync`
 * twins (Transport.cs); a scan for a non-public member named once found none dead (Json's HandleNull is an override,
 * Realtime's ProvenTransport public). Result.cs +1,013 (Result: IsOk, Error throwing on an Ok, Response, Match;
 * Result<T>: Value throwing on an Err, TryGetValue, Match), Errors.cs +350 (SdkException, the answers' base:
 * ApiStatusException and DecodeException), Exchange.cs +501 (a body past the cap read as an answer, a 2xx's
 * DecodeException; a realtime dial's still no answer), Transport.cs -678 (the five twins cut, Transport.Safe's two
 * overloads, the twins' one path), Adapters.cs +12 (the dial flag).
 * Bit 21 i7, +25 B to 134,903 B: Adapters.cs +25, a realtime send's POST no dial (`With`'s dial parameter), so its
 * 2xx past the cap is the exchange's DecodeException, not ApiConnectionException.
 */
const CSHARP_RUNTIME_BYTES = 134_903

describe("the C# runtime within its byte budget (bit 15, G14)", () => {
	it(
		`ships every runtime file it holds, their bytes exactly ${CSHARP_RUNTIME_BYTES}, nothing else beside them`,
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const { runtimeFileNames: csharpRuntimeFileNames } = await import("../src/emit/csharp/transport.ts")
			const { bytes, names, others } = runtimeBytes(runtimeDir("csharp"), ".cs")
			expect({ bytes, names, others }).toEqual({
				bytes: CSHARP_RUNTIME_BYTES,
				names: csharpRuntimeFileNames({ realtime: true, ws: true }),
				others: [],
			})
		},
	)
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
 * Bit 19 f, +402 B to 119,636 B: a realtime send's raw form, sendText, as the siblings' (sweep 14): the method and its
 * type (+113) with a one-line comment (+86), its text POSTed as text/plain over SSE and long-poll (+187), and safely
 * moved to realtime.ts so realtime-connection.ts stays at the line cap (+16: its import and export).
 * Bit 19 f2, +699 B to 120,335 B: a network failure is APIConnectionError, the platform's error its cause, as the
 * siblings' connection errors (error.ts +663: the class +88, the fetch wrapper that leaves an aborted request's error as
 * it is +440, two short comments +135; http.ts +36, the client's fetch wrapped).
 * Bit 19 g, +7 B to 120,342 B: request.ts exports headerValue, b1's header check, so the MCP server checks
 * $<PREFIX>_HEADERS with the SDK's own rule.
 * Counted: every runtime .ts file, each one RUNTIME_MODULES joins; the directory holds nothing else. A raise names its
 * feature bytes and cuts dead and duplicate code first; it is never silent.
 * Bit 19 k1, +362 B of doc only, to 120,704 B: sse.ts +113 (leaving a `for await` early frees the connection),
 * ws.ts +249 (the dial runs no onRequest or onResponse hook and no onAuthExpired refresh; the platform WebSocket
 * has no ping and no message cap).
 * Bit 21 e, +90 B to 120,794 B: connectionErrors' fetch wrapper asserted as the platform's fetch (+29) with its one-line
 * reason (+61), so a generated SDK type-checks under Bun's types, whose fetch also names `preconnect`: the MCP app's
 * mounted handler embeds the SDK, and its Bun host's type check is the first to read it there.
 * Bit 21 i0 (F1), +843 B to 121,637 B: a stream whose connection drops mid-answer is APIConnectionError, through the
 * call's own f2 path, no second wrapper: error.ts +247 (noAnswer, connectionErrors' catch made a function both call),
 * http.ts +85 (each Sent's failed, bound to its request), sse.ts +428 (readerOf: a failed read throws failed's error,
 * split out of parseSSEStream at its complexity cap), response.ts +83 (Sent.failed). Nothing cut: the catch moved.
 * Bit 21 i1, +369 B to 122,006: the normal client always throws and `client.safe` answers a Result (R-i2..R-i4), the
 * old safe mode cut first. Cut: SafeResult, safeErrorValue, success and finishRequest's two modes (response.ts),
 * requestSafe, requestOperation's status-0 result and every shouldThrow (http.ts), ClientResult, ErrorVariants,
 * HasStatusErrors and TThrow (app-types.ts), createClient's three TThrow overloads (app.ts), throwOnError (config.ts),
 * the poll's shouldThrow (realtime-transports.ts -21). Added: DecodeError, its cause through ClientErrorInit
 * (error.ts +320); Answer, Result with its per-status errors, resultOf, and finishRequest's failed body read as no
 * answer (response.ts +433); the twin's flag through namespace, memberOf and callable, `safe` itself, open() for a
 * stream's opening, a 2xx DecodeError still marking its targets, and memberOf's At and callable's `open`, which hold
 * sdk.ts at its 300-line cap (sdk.ts +530). Net of both: http.ts -351 (the
 * stream's open split out as openStream, `later` its lazy form), app-types.ts -334 (SafeReturnFor and SafeMethod in),
 * app.ts -184 (safeMethods in), config.ts -24.
 * Bit 21 i1 fold-in, +267 B to 122,273: the Err arm widened once, inside Result (never per operation), with the base
 * ClientError at every undeclared error status: Upto, 0 to N-1 as literals, with its comment (+150); the base member,
 * its status 300 to 599 less the declared ones, so a declared status still narrows its body (+117, the comment
 * rewritten included). response.ts alone.
 */
const TS_RUNTIME_BYTES = 122_273

describe("the TS runtime within its byte budget (bit 11, G14)", () => {
	it(
		`ships every runtime file it holds, their bytes exactly ${TS_RUNTIME_BYTES}, nothing else beside them`,
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const { bytes, names, others } = runtimeBytes(runtimeDir("ts"), ".ts")
			expect({ bytes, names, others }).toEqual({
				bytes: TS_RUNTIME_BYTES,
				names: RUNTIME_MODULES.map((name) => `${name}.ts`).sort(),
				others: [],
			})
		},
	)
})
