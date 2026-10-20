/**
 * The C# gate fixture and test driver (contract 45 §6, Fb9, Fb10, Fb12): a registry project is built once per
 * content hash and a second gate spawns nothing, a failed build stays failed, the format gate runs once per dir,
 * a consumer check once per program, and a program runs beside the SDK's dll; the driver is built once per source
 * hash with no reference to any SDK; the emitter's call plans name what it walks; it sends one cell against the
 * recording server, observing data, the raw response, a status error and a timeout; and it refuses what it cannot
 * drive (a multipart body, a bad script) before the SDK loads. Its streams and their refusals are
 * sdk.driver.stream.test.ts's.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { compiledCSharp } from "./__fixtures__/compiled.ts"
import { execDotnet, withDotnet } from "./__fixtures__/csharp-env.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { drivenCSharpSdk, driverDll } from "./__fixtures__/driven.ts"
import type { CSharpCallPlan } from "./sdk-plan.ts"
import { csharpCallPlans } from "./sdk.ts"

/* every spawn counted, so a gate the cache answers is shown to start no process at all */
vi.mock("node:child_process", async (original) => {
	const real = await original<typeof import("node:child_process")>()
	return { ...real, spawn: vi.fn(real.spawn), spawnSync: vi.fn(real.spawnSync) }
})

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()

const spawns = () => vi.mocked(spawn).mock.calls.length + vi.mocked(spawnSync).mock.calls.length

const OP = "orgs.members.notes.create"

/** The NOTES op's plan, in the emitter's names: two path params in path order, a query and a header param, a JSON body. */
const NOTES: CSharpCallPlan = {
	accessors: ["Orgs", "Members", "Notes"],
	body: { kind: "json", param: "body" },
	headers: { "X-Trace": "xTrace" },
	idempotencyKey: null,
	method: "CreateAsync",
	operation: OP,
	path: [
		{ name: "org", param: "org" },
		{ name: "member", param: "member" },
	],
	query: { tag: "tag" },
	required: ["org", "member", "body"],
	response: "json",
	responseHeaders: null,
	stream: null,
	throws: true,
}

/** A program over the dependency-free `cache` project: its `One.Value`, its first argument and its stdin. */
const PROBE = `internal static class P
{
    private static void Main(string[] args) =>
        System.Console.WriteLine($"{Cache.Probe.One.Value} {args[0]} {System.Console.In.ReadToEnd().Trim()}");
}
`

/** A program that reads none of its stdin. */
const SILENT = "internal static class P\n{\n    private static void Main() => System.Console.WriteLine(3);\n}\n"

/** Every file under `dir`, relative, sorted. */
const filesUnder = (dir: string) =>
	readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
		.sort()

describe.skipIf(!DOTNET)("the gate cache: one build per content hash", () => {
	it("builds a registry project once: a second gate reads its marker and spawns nothing", () => {
		const first = compiledCSharp("cache")
		expect(
			{ built: first.built, complete: existsSync(join(first.dir, ".complete")) },
			first.diagnostics.join("\n"),
		).toEqual({ built: true, complete: true })
		const before = spawns()
		const second = compiledCSharp("cache")
		expect({ ...second, spawned: spawns() - before }).toMatchObject({
			built: true,
			diagnostics: [],
			dir: first.dir,
			fresh: false,
			spawned: 0,
		})
	})

	it("writes the project exactly as given under src, beside the pin and an offline NuGet config, and names its dll", () => {
		const sdk = compiledCSharp("cache")
		const own = filesUnder(sdk.dir).filter((file) => !/^(?:\.complete|\.format|art\/|checks\/|programs\/)/.test(file))
		expect({ assembly: sdk.assembly, dll: existsSync(sdk.dll), own, src: sdk.src }).toEqual({
			assembly: "Cache.Probe",
			dll: true,
			own: [
				"NuGet.Config",
				"global.json",
				...Object.keys(FIXTURES.cache.files)
					.map((name) => `src/${name}`)
					.sort(),
			].sort(),
			src: join(sdk.dir, "src"),
		})
		expect(sdk.dll).toBe(join(sdk.dir, "art/bin/Cache.Probe/release/Cache.Probe.dll"))
	})

	it("keeps a failed build failed, its diagnostics by file and line, and spawns nothing the second time", () => {
		const canary = compiledCSharp("canary")
		expect({ built: canary.built, diagnostics: canary.diagnostics }).toEqual({
			built: false,
			diagnostics: ["Canary.cs(7,13): error CS0168: The variable 'unused' is declared but never used"],
		})
		const before = spawns()
		expect({ built: compiledCSharp("canary").built, spawned: spawns() - before }).toEqual({ built: false, spawned: 0 })
	})
})

describe.skipIf(!DOTNET)("the gate's format runs, checks and programs: once per dir, program text or compile", () => {
	it("runs the format gate once per dir: clean for the cache project, the mis-indented line for the canary", () => {
		const findings = compiledCSharp("canary").format()
		expect(findings).toEqual(["Canary.cs(8,9): error WHITESPACE: Fix whitespace formatting. Delete 2 characters."])
		expect(compiledCSharp("cache").format()).toEqual([])
		const before = spawns()
		expect({ canary: compiledCSharp("canary").format(), cache: compiledCSharp("cache").format() }).toEqual({
			cache: [],
			canary: findings,
		})
		expect(spawns() - before).toBe(0)
	})

	it("reports csc's errors for a consumer program by line, once per program", () => {
		const sdk = compiledCSharp("cache")
		const bad = "internal static class P\n{\n    private static void Main() { string s = Cache.Probe.One.Value; }\n}\n"
		expect(sdk.check(PROBE)).toEqual([])
		expect(sdk.check(bad)).toEqual(["(3,45): error CS0029: Cannot implicitly convert type 'int' to 'string'"])
		const before = spawns()
		expect({ again: sdk.check(bad), spawned: spawns() - before }).toMatchObject({ spawned: 0 })
	})

	it("runs a program beside the dll with its args and its input on stdin, however large an unread input", async () => {
		const sdk = compiledCSharp("cache")
		expect(await sdk.exec(PROBE, "hi\n", ["base"])).toEqual({ status: 0, stderr: "", stdout: "1 base hi\n" })
		/* more than a pipe holds: the program exits before the write ends, which must not surface as EPIPE */
		expect(await sdk.exec(SILENT, "x".repeat(4 << 20))).toEqual({ status: 0, stderr: "", stdout: "3\n" })
		const broken = await sdk.exec("internal static class P { }\n", "")
		expect([broken.status, broken.stderr]).toEqual([
			1,
			"error CS5001: Program does not contain a static 'Main' method suitable for an entry point",
		])
	})
})

/** The driver run on `envelope` as given: the refusals come before the SDK loads, so no SDK need be gated. */
const driverOn = async (envelope: object) => {
	const ran = await execDotnet([driverDll()], { input: JSON.stringify(envelope) })
	return { status: ran.status, stderr: ran.stderr.trim(), stdout: ran.stdout }
}

/** An envelope aimed at the `cache` project's dll, which exports no JsonSerializerContext. */
const envelopeOf = (cell: object, plans: Readonly<Record<string, CSharpCallPlan>>) => ({
	base: "http://127.0.0.1:9",
	cell,
	plans,
	sdk: { client: "AcmeClient", dll: compiledCSharp("cache").dll, namespace: "Acme" },
})

describe.skipIf(!DOTNET)("the C# test driver: its build and what it refuses", () => {
	it("builds once per source hash, with no SDK: the same dll, the second time with no spawn", () => {
		const dll = driverDll()
		expect(existsSync(dll)).toBe(true)
		const before = spawns()
		expect({ dll: driverDll(), spawned: spawns() - before }).toEqual({ dll, spawned: 0 })
	})

	it("refuses a multipart body before the SDK loads: a consumer program sends FileParts", async () => {
		const upload = { body: { kind: "json", value: {} }, operation: OP, route: { method: "POST", path: "/" } }
		const multipart: CSharpCallPlan = { ...NOTES, body: { kind: "multipart", param: "body" } }
		expect(await driverOn(envelopeOf({ calls: [upload] }, { [OP]: multipart }))).toEqual({
			status: 1,
			stderr: `driver: call 0 (${OP}): a multipart body is driven by a consumer program (FilePart)`,
			stdout: "",
		})
	})

	it("decodes a script strictly before the SDK loads; refuses an unknown call member and an SDK exporting no JsonSerializerContext", async () => {
		const create = { operation: OP, route: { method: "POST", path: "/" } }
		const scripted = (script: object) => ({ ...envelopeOf({ calls: [create] }, { [OP]: NOTES }), script })
		expect((await driverOn(scripted({ calls: [{ wait: 1 }] }))).stderr).toBe("driver: script: unknown member wait")
		expect((await driverOn(scripted({ hooks: { request: [{ setHeader: ["X"] }] } }))).stderr).toBe(
			"driver: script: a request hook's setHeader is [name, value]",
		)
		const unknown = envelopeOf({ calls: [{ ...create, cancel: true }] }, { [OP]: NOTES })
		expect((await driverOn(unknown)).stderr).toMatch(/^driver: the envelope does not decode: .*'cancel'/)
		expect((await driverOn(envelopeOf({ calls: [create] }, { [OP]: NOTES }))).stderr).toBe(
			"driver: the SDK exports 0 JsonSerializerContext types, not one",
		)
	})
})

describe("csharpCallPlans: each operation's call plan, in the emitter's own names", () => {
	it("names the accessors, the method, the path params in path order and every parameter", () => {
		expect(csharpCallPlans(FIXTURES.surface.document(), FIXTURES.surface.options)[OP]).toEqual(NOTES)
	})
})

/** The create call the smoke sends: path params needing escapes, a query, the header param, a JSON body. */
const CREATE: Call = {
	body: { kind: "json", value: { tags: ["a"], text: "hi" } },
	headers: { "x-trace": "t-1" },
	operation: OP,
	params: { member: "m?1", org: "a/b c" },
	route: { method: "POST", path: "/orgs/{org}/members/{member}/notes" },
	search: { tag: "x&y z" },
}

const NOTE = { json: { id: "n1", text: "hi" }, status: 200 } as const

describe.skipIf(!DOTNET)("the C# test driver, against the recording server", () => {
	it("sends a nested POST by its call plan, binding every argument through the SDK's own context", async () => {
		const sdk = drivenCSharpSdk("surface")
		expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
		const setup = { auth: { kind: "bearer", token: "tok" } } as const
		const [run, hops] = await served([NOTE], async (server) => {
			/* the surface's own server has a base path: the hop shows it kept */
			const ran = await sdk.runCalls({ calls: [CREATE], setup }, { url: `${server.url}/v1` })
			return [ran, server.hops] as const
		})
		expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({
			observed: [{ data: { id: "n1", text: "hi" }, kind: "data", status: 200 }] satisfies Observed[],
			status: 0,
		})
		expect(hops).toMatchObject([
			{
				body: { contentType: "application/json", json: { tags: ["a"], text: "hi" } },
				headers: { authorization: "Bearer tok", "x-trace": "t-1" },
				method: "POST",
				url: "/v1/orgs/a%2Fb%20c/members/m%3F1/notes?tag=x%26y+z",
			},
		])
	}, 120_000)

	it("observes the raw response, a status error with its body, and a timeout", async () => {
		const sdk = drivenCSharpSdk("surface")
		const replies = [NOTE, { json: { message: "no" }, status: 404 }, { ...NOTE, delayMs: 2_000 }]
		const calls: readonly Call[] = [{ ...CREATE, raw: true }, CREATE, { ...CREATE, timeoutMs: 150 }]
		const run = await served(replies, (server) => sdk.runCalls({ calls }, { url: `${server.url}/v1` }))
		expect({ observed: run.observed, status: run.status }, run.stderr).toMatchObject({
			observed: [
				{ body: '{"id":"n1","text":"hi"}', headers: { "content-type": "application/json" }, kind: "raw", status: 200 },
				{ body: { message: "no" }, errorKey: null, kind: "error", status: 404 },
				{ kind: "timeout" },
			],
			status: 0,
		})
	}, 120_000)

	it("refuses a bad script on a registry SDK before any call is sent", async () => {
		const sdk = drivenCSharpSdk("surface")
		const [run, hops] = await served([], async (server) => {
			const ran = await sdk.runCalls({ calls: [CREATE] }, { url: server.url }, { script: { calls: [null, null] } })
			return [ran, server.hops] as const
		})
		expect({ hops: hops.length, observed: run.observed, status: run.status, stderr: run.stderr.trim() }).toEqual({
			hops: 0,
			observed: undefined,
			status: 1,
			stderr: "driver: script: 2 calls scripted for a cell of 1",
		})
	}, 120_000)
})
