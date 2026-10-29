/**
 * The C# target of the conformance grid (R1/G17): every `cellsFor("csharp")` cell through the SDK
 * `generateCSharpSdk` emits from the spawned reference app's served document, built once per content hash and
 * format-clean, and sent by the fixed reflection driver, one process per cell, `Observed[]` back. C# has one
 * client, one SDK pin and no dependency to drift, so the file holds no floor or drift suite (bits/15). The safe
 * variant (bit 21 i5, R-i6) sends one cell per response kind through `client.Safe` on the same build, the driver
 * reading each `Result` strictly, and its compile leg holds every operation's safe call to its normal one and narrows
 * it under csc. Opt-in: `vitest run --mode harness`.
 */
import { describe, expect, it } from "vitest"
import { clientOf, program } from "../../../src/emit/csharp/__fixtures__/consumer.ts"
import { type DrivenCSharpSdk, servedCSharpSdk } from "../../../src/emit/csharp/__fixtures__/driven.ts"
import { withDotnet } from "../../../src/emit/csharp/__fixtures__/csharp-env.ts"
import { csharpCallPlans } from "../../../src/emit/csharp/sdk.ts"
import type { CSharpCallPlan } from "../../../src/emit/csharp/sdk-plan.ts"
import { originsOf, type ReferenceApp, type TargetRunner, targetSuite } from "./harness.ts"
import type { Observed } from "./matrix.ts"
import { SAFE } from "./safe.ts"

const DOTNET = withDotnet()

/* ported: rust.test.ts:33-53, python.test.ts:59-88 (the runner); the grid is shared */
/**
 * The C# runner, in the normal style or the safe one: the SDK built once from the served document (both runners
 * share the build), under warnings as errors, nullable and the trim/AOT analyzers, and `dotnet format`-clean (Fe1).
 * A cell the driver cannot express exits non-zero with the reason on stderr, and the runner throws it: the cell is
 * red, never skipped. A cold prepare fits the default hook timeout.
 */
function csharpRunner(variant?: typeof SAFE): TargetRunner {
	let sdk: DrivenCSharpSdk | undefined
	return {
		async prepare(app) {
			const served = servedCSharpSdk(app.document)
			if (!served.built) throw new Error(served.diagnostics.join("\n"))
			const findings = served.format()
			if (findings.length > 0) throw new Error(findings.join("\n"))
			sdk = served
		},
		async run(cell, app) {
			if (sdk === undefined) throw new Error("the C# runner ran a cell before prepare")
			const ran = await sdk.runCalls(cell, originsOf(app), undefined, variant === SAFE)
			if (ran.status !== 0) throw new Error(`driver exit ${ran.status}: ${ran.stderr}`)
			return ran.observed as readonly Observed[]
		},
		target: "csharp",
		variant,
	}
}

/** What a safe call is held to: the very connection, a Result of its stream, of no body, or of its answer. */
const twinKind = (plan: CSharpCallPlan) =>
	plan.stream === "ws" || plan.stream === "realtime"
		? "ident"
		: plan.stream === "sse"
			? "stream"
			: plan.response === "none"
				? "none"
				: "value"

/** One operation's method on `client`: its required arguments `default!`, positional (each its parameter's type). */
const at = (plan: CSharpCallPlan, client: string) =>
	[client, ...plan.accessors, `${plan.method}(${plan.required.map(() => "default!").join(", ")})`].join(".")

/** One operation's lines: its safe call held to its normal one (the same answer), awaited and narrowed. */
function safeOp(plan: CSharpCallPlan, i: number): string[] {
	const held = `Hold(${at(plan, "c")}, ${at(plan, "c.Safe")})`
	const body = {
		ident: [`        _ = Ident(${at(plan, "c")}, ${at(plan, "c.Safe")});`],
		none: [`        Narrow(await ${held});`],
		stream: [
			`        if (Narrow(await ${held}) is { } s)`,
			"        {",
			"            await foreach (var _ in s)",
			"            {",
			"                break;",
			"            }",
			"        }",
		],
		value: [`        _ = Narrow(await ${held});`],
	}[twinKind(plan)]
	const sync = twinKind(plan) === "ident"
	return [`    public static ${sync ? "void" : "async Task"} Op${i}(${CLIENT} c)`, "    {", ...body, "    }"]
}

/* the program's stand-in for the client's class name, set per document */
const CLIENT = "{client}"

/**
 * The compile leg's types (R-i6 a): for every operation, its `client.Safe` call held to the normal one (`Hold`: the
 * same answer `T`, `Task<T>` against `Task<Result<T>>`; a no-body one `Task` against `Task<Result>`), awaited and
 * narrowed through every member of `Result` (`IsOk`, `Value`, `Error` as the `SdkException` base and each of its two
 * kinds, `Response`, `Match`, `TryGetValue`); a connection the very same method on both. Never run: compiling it is
 * the assertion.
 */
function safeTypes(plans: readonly CSharpCallPlan[], client: string): string {
	return [
		"/* bit 21 i5, R-i6 (a): every operation's safe call, held to its normal one and narrowed */",
		"internal static class SafeLeg",
		"{",
		"    private static Task<Result<T>> Hold<T>(Task<T> normal, Task<Result<T>> safe) => safe;",
		"",
		"    private static Task<Result> Hold(Task normal, Task<Result> safe) => safe;",
		"",
		"    private static T Ident<T>(T normal, T safe) => safe;",
		"",
		"    private static void Narrow(Result r)",
		"    {",
		"        RawResponse response = r.Response;",
		"        _ = r.IsOk ? response.Status : Kind(r.Error);",
		"        _ = r.Match(() => 0, Kind);",
		"    }",
		"",
		"    private static T? Narrow<T>(Result<T> r)",
		"    {",
		"        Narrow((Result)r);",
		"        _ = r.Match<T?>(v => v, e => default);",
		"        return r.TryGetValue(out var value) ? value : r.IsOk ? r.Value : default;",
		"    }",
		"",
		"    private static int Kind(SdkException e) => e switch",
		"    {",
		"        ApiStatusException status => status.Status,",
		"        DecodeException decode => decode.Message.Length,",
		"        _ => 0,",
		"    };",
		"",
		...plans.flatMap((plan, i) => [...safeOp(plan, i), ""]),
		"    public static int Count => " + String(plans.length) + ";",
		"}",
	]
		.join("\n")
		.replaceAll(CLIENT, client)
}

/** The compile leg (R-i6 a): safeTypes over the served document's SDK, checked clean by csc, and not vacuous. */
function compileLeg(app: () => ReferenceApp) {
	describe("conformance × csharp (safe): every operation's safe call compiles", () => {
		it("holds each client.Safe call to its normal one, awaits it and narrows its Result, under csc", () => {
			const plans = Object.values(csharpCallPlans(app().document))
			const kinds = plans.map(twinKind)
			expect({
				calls: plans.length > 20,
				connections: kinds.includes("ident"),
				none: kinds.includes("none"),
				streams: kinds.includes("stream"),
			}).toEqual({ calls: true, connections: true, none: true, streams: true })
			const sdk = servedCSharpSdk(app().document)
			expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
			const { client, namespace } = clientOf(sdk)
			const source = program(namespace, client, "Note(SafeLeg.Count);", safeTypes(plans, client))
			expect(sdk.check(source)).toEqual([])
		}, 600_000)
	})
}

describe.skipIf(!DOTNET)("csharp toolchain", () => {
	const app = targetSuite(csharpRunner())
	targetSuite(csharpRunner(SAFE))
	compileLeg(app)
})
