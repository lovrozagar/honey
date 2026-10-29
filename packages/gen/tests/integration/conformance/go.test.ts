/**
 * The Go target of the conformance grid (R1/G11): every `cellsFor("go")` cell through the SDK
 * `generateGoSdk` emits from the spawned reference app's served document, compiled once per content
 * hash with the test driver beside it and sent by it, one process per cell, `Observed[]` back. That
 * SDK also builds and vets under the go 1.24 floor toolchain. The safe variant (bit 21 i3, R-i6) sends one cell per
 * response kind through `client.Safe()`, the driver reading each Result strictly, and its compile leg holds every
 * operation's safe twin to its normal method under go build and vet. Opt-in: `vitest run --mode harness`.
 */
import { describe, expect, it } from "vitest"
import { compileGo, compiledSdk, type DrivenSdk } from "../../../src/emit/go/__fixtures__/compiled.ts"
import { GO_FLOOR, withGo } from "../../../src/emit/go/__fixtures__/go-env.ts"
import type { GoCallPlan } from "../../../src/emit/go/sdk-client.ts"
import { generateGoSdk, goCallPlans } from "../../../src/emit/go/sdk.ts"
import { originsOf, type ReferenceApp, type TargetRunner, targetSuite } from "./harness.ts"
import { cellsFor, type Observed } from "./matrix.ts"
import { SAFE } from "./safe.ts"

/* the module path both Go harness files compile the conformance SDK under, so they share one cache dir */
const MODULE = "example.com/conformance"

/** Each titled cell's v0 port: the suite names its `it` `<key> (<title>)`. */
const V0_PORTS: Readonly<Record<string, string>> = {
	// v0: 4ac6a2896c
	"verbs/reference-request": "v0 4ac6a2896c",
}

/**
 * The Go runner: the SDK and the driver built and vetted once from the served document. A cell the
 * driver cannot express exits non-zero with the reason on stderr, and the runner throws it: the
 * cell is red, never skipped.
 */
function goRunner(variant?: typeof SAFE): TargetRunner {
	let sdk: DrivenSdk | undefined
	return {
		async prepare(app) {
			const compiled = compiledSdk(app.document, { modulePath: MODULE })
			if (!compiled.built || compiled.vet.length > 0) throw new Error(`${compiled.stderr}${compiled.vet.join("\n")}`)
			sdk = compiled
		},
		async run(cell, app) {
			if (sdk === undefined) throw new Error("the Go runner ran a cell before prepare")
			const ran = await sdk.runCalls(cell, originsOf(app), undefined, variant === SAFE)
			if (ran.status !== 0) throw new Error(`driver exit ${ran.status}: ${ran.stderr}`)
			return ran.observed as readonly Observed[]
		},
		target: "go",
		titles: variant === undefined ? V0_PORTS : {},
		variant,
	}
}

/** What a twin is held to: the same method (a connection), a Result of a stream, of no answer, or of the answer. */
const twinKind = (plan: GoCallPlan) =>
	plan.stream === "ws" || plan.stream === "realtime"
		? "ident"
		: plan.stream === "sse"
			? "stream"
			: plan.returns === "error"
				? "none"
				: "value"

/** The arguments before `reqOpts`: ctx, the path params, the body, the Opts. */
const arity = (plan: GoCallPlan) => 2 + plan.pathParams.length + (plan.body === null ? 0 : 1)

/**
 * `<kind><n>`: unifies a twin's parameters with its normal method's (each P inferred from both, so one that differs
 * fails to build) and its answer `T` with what the normal method returns, then hands back zero arguments to call the
 * twin with. Never run: building it is the assertion.
 */
function helper(kind: string, n: number): string {
	const ps = Array.from({ length: n }, (_, i) => `P${i}`)
	const params = `${ps.join(", ")}, ...sdk.RequestOption`
	const [safe, normal] = {
		none: ["(sdk.Result[struct{}], error)", "error"],
		stream: ["(sdk.Result[T], error)", "T"],
		value: ["(sdk.Result[T], error)", "(T, error)"],
	}[kind] as [string, string]
	const types = kind === "none" ? `${ps.join(", ")} any` : `${ps.join(", ")}, T any`
	return [
		`func ${kind}${n}[${types}](safe func(${params}) ${safe}, normal func(${params}) ${normal}) (${ps.join(", ")}) {`,
		...ps.map((p, i) => `\tvar p${i} ${p}`),
		`\treturn ${ps.map((_, i) => `p${i}`).join(", ")}`,
		"}",
	].join("\n")
}

/** One operation's lines: its twin held to its normal method, called, and its Result narrowed (a stream's ranged). */
function safeOp(plan: GoCallPlan, i: number): string {
	const path = [...plan.members, plan.method].join(".")
	const kind = twinKind(plan)
	if (kind === "ident") return `func op${i}(c *sdk.Client) { ident(c.Safe().${path}, c.${path}) }`
	const args = Array.from({ length: arity(plan) }, (_, j) => `a${j}`).join(", ")
	return [
		`func op${i}(c *sdk.Client) {`,
		`\t${args} := ${kind}${arity(plan)}(c.Safe().${path}, c.${path})`,
		`\tr := narrow(c.Safe().${path}(${args}))`,
		...(kind === "stream" ? ["\tfor ev, err := range r {", "\t\t_, _ = ev, err", "\t}"] : ["\t_ = r"]),
		"}",
	].join("\n")
}

/**
 * The compile leg's program (R-i6 a): for every operation, its `Client.Safe()` twin held to the normal method (the same
 * parameters, a `Result` of the very answer), called, and its Result narrowed: `Err` exactly `error`, read with
 * errors.As as a `*DecodeError` or a `*ClientError`, `Response` a `*http.Response`; a connection the very same method.
 */
function safeDriver(module: string, plans: readonly GoCallPlan[]): string {
	const helpers = [...new Set(plans.filter((p) => twinKind(p) !== "ident").map((p) => `${twinKind(p)} ${arity(p)}`))]
		.sort()
		.map((key) => {
			const [kind, n] = key.split(" ") as [string, string]
			return helper(kind, Number(n))
		})
	return [
		"package main",
		"",
		"import (",
		'\t"errors"',
		'\t"net/http"',
		"",
		`\tsdk ${JSON.stringify(module)}`,
		")",
		"",
		"func ident[F any](safe, normal F) {}",
		"",
		"func narrow[T any](r sdk.Result[T], err error) T {",
		"\tvar _ *error = &r.Err",
		"\tvar _ **http.Response = &r.Response",
		"\tvar de *sdk.DecodeError",
		"\tvar ce *sdk.ClientError",
		"\tswitch {",
		"\tcase err != nil, r.Ok():",
		"\tcase errors.As(r.Err, &de):",
		"\t\t_ = de.Response",
		"\tcase errors.As(r.Err, &ce):",
		"\t\t_ = ce.StatusCode",
		"\t}",
		"\treturn r.Data",
		"}",
		"",
		...helpers.flatMap((h) => [h, ""]),
		...plans.flatMap((plan, i) => [safeOp(plan, i), ""]),
		"func main() {",
		...plans.map((_, i) => `\t_ = op${i}`),
		"}",
		"",
	].join("\n")
}

/** The compile leg (R-i6 a): safeDriver over the served document's SDK, built and vetted clean, and not vacuous. */
function compileLeg(app: () => ReferenceApp) {
	describe("conformance × go (safe): every operation's safe call compiles", () => {
		it("holds each Safe() twin to its normal method, calls it and narrows its Result, under go build and vet", () => {
			const plans = Object.values(goCallPlans(app().document, { modulePath: MODULE }))
			const kinds = plans.map(twinKind)
			expect({
				calls: plans.length > 20,
				connections: kinds.includes("ident"),
				none: kinds.includes("none"),
				streams: kinds.includes("stream"),
			}).toEqual({ calls: true, connections: true, none: true, streams: true })
			const files = generateGoSdk(app().document, { modulePath: MODULE }).files
			const built = compileGo(files, { main: safeDriver(MODULE, plans) })
			expect({ built: built.built, vet: built.vet }, built.stderr).toEqual({ built: true, vet: [] })
		}, 600_000)
	})
}

describe.skipIf(!withGo())("go toolchain", () => {
	const app = targetSuite(goRunner())
	targetSuite(goRunner(SAFE))
	compileLeg(app)

	describe("conformance × go titles", () => {
		it("titles only cells the grid holds for go", () => {
			const keys = new Set(cellsFor("go").map((cell) => cell.key))
			expect(Object.keys(V0_PORTS).filter((key) => !keys.has(key))).toEqual([])
		})
	})

	/*
	 * format.test.ts compiles every runtime file under the floor; this leg adds the conformance SDK's
	 * own client.go and types.go there: error-only methods, binary in and out, form and text bodies,
	 * typed response headers, error envelopes. The served document is the one fetched at start.
	 */
	describe("go 1.24 floor", () => {
		it("builds and vets the conformance SDK clean under the floor toolchain itself", () => {
			const files = generateGoSdk(app().document, { modulePath: MODULE }).files
			const floor = compileGo(files, { toolchain: GO_FLOOR })
			expect({ built: floor.built, vet: floor.vet }, floor.stderr).toEqual({ built: true, vet: [] })
		}, 600_000)
	})
})
