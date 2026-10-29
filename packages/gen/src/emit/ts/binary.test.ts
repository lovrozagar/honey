import { Project, ts } from "ts-morph"
import { beforeAll, describe, expect, it } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, unknown>
type Result = { ok: boolean; data?: unknown; headers?: Json; response: Response }
type Call = (input?: Json) => Promise<unknown>
type Ops = { files: { binary: Call; pdf: Call }; reports: { get: Call } }
type Sdk = Ops & { safe: Ops }

const bytesOf = (type: string) => ({
	200: { content: { [type]: { schema: { format: "binary", type: "string" } } }, description: "" },
})
const HEADERS = {
	"x-next-cursor": { schema: { type: "string" } },
	"x-rate-limit-remaining": { required: true, schema: { type: "string" } },
}
const DOC = {
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/files/binary": { get: { operationId: "files.binary", responses: bytesOf("application/octet-stream") } },
		"/files/pdf": { get: { operationId: "files.pdf", responses: bytesOf("application/pdf") } },
		"/reports": {
			get: {
				operationId: "reports.get",
				responses: {
					200: { content: { "application/json": { schema: { type: "object" } } }, description: "", headers: HEADERS },
				},
			},
		},
	},
}

/** A response carrying `bytes` as `type`. */
const bytes = (type: string, body = new Uint8Array([1, 2, 3])) =>
	new Response(body, { headers: { "content-type": type } })

/** A client of the SDK emitted for `DOC`, answering every request with `answer`. */
async function sdk(answer: () => Response, config: Json = {}): Promise<{ calls: Request[]; client: Sdk }> {
	const { calls, fetch } = recordingFetch(answer)
	const TestSDK = (await emittedSdk(DOC)).TestSDK as new (config: Json) => Sdk
	return { calls, client: new TestSDK({ baseURL: "https://x", fetch, ...config }) }
}

describe("binary responses (A1)", () => {
	// v0: 568e4f0e86
	// v0: 7f7b89c686
	it("resolves an octet-stream or pdf body to its bytes as a Uint8Array", async () => {
		const { client: binary } = await sdk(() => bytes("application/octet-stream"))
		const { client: pdf } = await sdk(() => bytes("application/pdf", new Uint8Array([37, 80, 68, 70])))
		const results = [await binary.files.binary(), await pdf.files.pdf()]
		expect(results.map((data) => data instanceof Uint8Array)).toEqual([true, true])
		expect(results.map((data) => [...(data as Uint8Array)])).toEqual([
			[1, 2, 3],
			[37, 80, 68, 70],
		])
	})

	// v0: 8e1ed88266
	it("HTTPClient resolves an octet-stream body to a Uint8Array", async () => {
		const { fetch } = recordingFetch(() => bytes("application/octet-stream"))
		const Http = (await emittedApp()).HTTPClient as new (config: Json) => {
			request: (...args: unknown[]) => Promise<unknown>
		}
		const data = await new Http({ baseURL: "https://x", fetch }).request("GET", "/x", {})
		expect([data instanceof Uint8Array, [...(data as Uint8Array)]]).toEqual([true, [1, 2, 3]])
	})

	it("sets Accept to the declared media type", async () => {
		const { calls, client } = await sdk(() => bytes("application/octet-stream"))
		await client.files.binary()
		await client.files.pdf()
		expect(calls.map((call) => call.headers.get("accept"))).toEqual(["application/octet-stream", "application/pdf"])
	})

	it("streams the bytes through the raw response's body", async () => {
		const { calls, client } = await sdk(() => bytes("application/octet-stream"))
		const response = (await client.files.binary({ raw: true })) as Response
		const read: number[] = []
		for await (const chunk of response.body as ReadableStream<Uint8Array>) read.push(...chunk)
		expect([read, calls[0]?.headers.get("accept")]).toEqual([[1, 2, 3], "application/octet-stream"])
	})
})

describe("typed response headers (A2)", () => {
	it("exposes the declared response headers on the safe call's Ok, and only those", async () => {
		const { client } = await sdk(() =>
			Response.json({}, { headers: { "X-Rate-Limit-Remaining": "9", "x-internal": "secret", "x-request-id": "r" } }),
		)
		const result = (await client.safe.reports.get()) as Result
		expect([result.ok, result.headers]).toEqual([true, { "x-rate-limit-remaining": "9" }])
	})
})

/** Type checks against the emitted SDK, each file's diagnostics expected empty. */
const CHECKS = {
	"bytes.check.ts": `
		import { TestSDK } from "./test-sdk.index.gen.ts"
		type IsAny<T> = 0 extends 1 & T ? true : false
		type IsBytes<T> = IsAny<T> extends true ? false : [T] extends [Uint8Array] ? ([Uint8Array<ArrayBuffer>] extends [T] ? true : false) : false
		type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
		type Data<R> = Extract<R, { ok: true }> extends { data: infer D } ? D : never
		export async function check(): Promise<void> {
			const client = new TestSDK({ baseURL: "https://x" })
			const binary = await client.safe.files.binary()
			const pdf = await client.safe.files.pdf()
			const thrownBinary = await client.files.binary()
			const thrownPdf = await client.files.pdf()
			const raw = await client.files.binary({ raw: true })
			const safeRaw = await client.safe.files.binary({ raw: true })
			const checks: [
				IsBytes<Data<typeof binary>>,
				IsBytes<Data<typeof pdf>>,
				IsBytes<typeof thrownBinary>,
				IsBytes<typeof thrownPdf>,
				Equal<typeof raw, Response>,
				Equal<Data<typeof safeRaw>, Response>,
			] = [true, true, true, true, true, true]
			void checks
		}
	`,
	"headers.check.ts": `
		import { TestSDK } from "./test-sdk.index.gen.ts"
		type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
		export async function check(): Promise<void> {
			const result = await new TestSDK({ baseURL: "https://x" }).safe.reports.get()
			const ok = result as Extract<typeof result, { ok: true }>
			const checks: [
				Equal<keyof typeof ok.headers, "x-next-cursor" | "x-rate-limit-remaining">,
				Equal<(typeof ok.headers)["x-rate-limit-remaining"], string>,
				Equal<(typeof ok.headers)["x-next-cursor"], string | undefined>,
			] = [true, true, true]
			void checks
		}
	`,
}

/** What a strict consumer reports compiling each of `CHECKS` beside the emitted `files`, by check file. */
function typeErrors(files: Readonly<Record<string, string>>): Record<string, string[]> {
	const project = new Project({
		compilerOptions: {
			allowImportingTsExtensions: true,
			lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			noEmit: true,
			strict: true,
			target: ts.ScriptTarget.ES2022,
			types: [],
		},
		useInMemoryFileSystem: true,
	})
	for (const [name, text] of Object.entries(files)) project.createSourceFile(`/sdk/${name}`, text)
	const checked = Object.entries(CHECKS).map(
		([name, text]) => [name, project.createSourceFile(`/sdk/${name}`, text)] as const,
	)
	return Object.fromEntries(
		checked.map(([name, file]) => [
			name,
			file.getPreEmitDiagnostics().map((d) => ts.flattenDiagnosticMessageText(d.compilerObject.messageText, "\n")),
		]),
	)
}

describe("SDK types: binary data and declared headers", () => {
	let errors: Record<string, string[]> = {}
	beforeAll(async () => {
		errors = typeErrors((await emittedSdk(DOC)).files)
	}, 60_000)

	// v0: cae5930955
	// v0: 53b55c0c13
	// v0: 1c77d518b8
	// v0: 0e8ef19fc9
	it("types an octet-stream or unknown-media (pdf) response as Uint8Array in the normal and safe calls, and raw as Response", () => {
		expect(errors["bytes.check.ts"]).toEqual([])
	})

	it("types the declared response headers, and only those, with their required-ness", () => {
		expect(errors["headers.check.ts"]).toEqual([])
	})
})
