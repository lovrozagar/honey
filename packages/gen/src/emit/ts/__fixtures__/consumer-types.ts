/**
 * The emitted `${stem}.types.gen.ts`, checked as a consumer sees it: a `consumer.ts` beside the emitted files imports
 * the SDK and states each type as a compile-time assertion, typechecked in-process (types.test.ts, types.safe.test.ts).
 */
import { generateSdk } from "../sdk.ts"

export type Json = Record<string, unknown>

/**
 * What every consumer starts with: the SDK, an instance and its safe twin, and the assertion helpers. `Data`,
 * `Failure` and `Declared` read a safe call's Result: its Ok arm's data, its Err arm, and the declared statuses' errors.
 */
const prelude = (stem: string) => `import { ClientError, DecodeError, TestSDK } from "./${stem}.index.gen.ts"
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
declare function expectType<T extends true>(): void
type Fn = (...args: never[]) => unknown
type Result<F extends Fn> = Awaited<ReturnType<F>>
type Data<F extends Fn> = Extract<Result<F>, { ok: true }> extends { data: infer D } ? D : never
type Failure<F extends Fn> = Extract<Result<F>, { ok: false }>
type Declared<F extends Fn> = Failure<F> extends { error: infer E } ? Exclude<E, DecodeError> : never
type Input<F extends Fn> = NonNullable<Parameters<F>[0]>
const sdk = new TestSDK({ baseURL: "https://api.example.com" })
const safe = sdk.safe
void ClientError
`

/**
 * A checker over one in-memory project, the lib files parsed once and each check swapping the SDK and the consumer:
 * each diagnostic of `consumer` (or, with `all`, of every emitted file too) beside the SDK of `document`. `morph` is
 * ts-morph, which only a test file imports (honey/boundaries).
 */
export function consumerChecker(morph: typeof import("ts-morph")) {
	const { Project, ts } = morph
	const project = new Project({
		compilerOptions: {
			allowImportingTsExtensions: true,
			lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			noEmit: true,
			skipLibCheck: true,
			strict: true,
			target: ts.ScriptTarget.ES2022,
		},
		useInMemoryFileSystem: true,
	})
	return (document: Json, consumer: string, scope: "all" | "consumer" = "consumer"): string[] => {
		for (const file of project.getSourceFiles()) project.removeSourceFile(file)
		const { files, stem } = generateSdk(document, { name: "TestSDK" })
		for (const [name, text] of Object.entries(files)) project.createSourceFile(`/sdk/${name}`, text)
		const main = project.createSourceFile("/sdk/consumer.ts", `${prelude(stem)}${consumer}\n`)
		const diagnostics = scope === "all" ? project.getPreEmitDiagnostics() : main.getPreEmitDiagnostics()
		return diagnostics.map((d) => {
			const text = d.getMessageText()
			const message = typeof text === "string" ? text : text.getMessageText()
			return `${d.getSourceFile()?.getBaseName()}:${d.getLineNumber()}: ${message}`
		})
	}
}

/** An OpenAPI 3.1 document of `paths`. */
export const doc = (paths: Json): Json => ({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths })

export const json = (schema: Json) => ({ content: { "application/json": { schema } }, description: "" })
export const object = (properties: Json, required = Object.keys(properties)) => ({
	properties,
	required,
	type: "object",
})
export const STRING = { type: "string" }
export const param = (name: string, schema: Json = STRING, place = "path") => ({
	in: place,
	name,
	required: true,
	schema,
})
