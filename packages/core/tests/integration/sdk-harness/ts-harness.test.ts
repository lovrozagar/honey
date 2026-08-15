import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"
import { loadMockSpec, startMockServerSubprocess } from "./harness-util.ts"

const STEM = "mock"

const FILE_NAMES: Record<string, string> = {
	client: `${STEM}.client.gen.ts`,
	index: `${STEM}.index.gen.ts`,
	map: `${STEM}.map.gen.ts`,
	runtime: `${STEM}.runtime.gen.ts`,
	types: `${STEM}.types.gen.ts`,
}

const TSCONFIG = JSON.stringify({
	compilerOptions: {
		allowSyntheticDefaultImports: true,
		esModuleInterop: true,
		module: "ESNext",
		moduleResolution: "Bundler",
		noEmit: false,
		skipLibCheck: true,
		strict: true,
		target: "ES2022",
	},
	include: ["*.ts"],
})

/* Drives one error-hierarchy test case end-to-end: writes generated SDK + a
 * caller script into a tmp dir, runs it under bun against the mock server,
 * returns parsed JSON stdout. Used by the typed-error tests below. */
async function runErrorHarnessScript(spec: Record<string, unknown>, testRunner: string): Promise<unknown> {
	const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
	const dir = mkdtempSync(join(tmpdir(), "honey-ts-harness-"))
	const { kill, port } = await startMockServerSubprocess()
	try {
		for (const [key, filename] of Object.entries(FILE_NAMES)) {
			const content = files[key as keyof typeof files]
			if (content !== null && content !== undefined) writeFileSync(join(dir, filename), content, "utf8")
		}
		writeFileSync(join(dir, "tsconfig.json"), TSCONFIG, "utf8")
		writeFileSync(join(dir, "test-runner.ts"), testRunner, "utf8")

		let stdout: string
		try {
			stdout = execSync("bun run test-runner.ts", {
				cwd: dir,
				encoding: "utf8",
				env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
				timeout: 15_000,
			})
		} catch (err: unknown) {
			const e = err as { stderr?: string; stdout?: string; message?: string }
			throw new Error(
				`bun run test-runner.ts failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
				{ cause: err },
			)
		}

		return JSON.parse(stdout.trim())
	} finally {
		kill()
		rmSync(dir, { force: true, recursive: true })
	}
}

describe("TS SDK integration harness", () => {
	const spec = loadMockSpec()

	it("codegen produces all files", () => {
		const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
		expect(typeof files.client).toBe("string")
		expect((files.client ?? "").length).toBeGreaterThan(0)
		expect(typeof files.index).toBe("string")
		expect((files.index ?? "").length).toBeGreaterThan(0)
		expect(typeof files.map).toBe("string")
		expect((files.map ?? "").length).toBeGreaterThan(0)
		expect(typeof files.types).toBe("string")
		expect((files.types ?? "").length).toBeGreaterThan(0)
		/* runtime is non-null only for x-realtime operations; spec.json has SSE but
		 * not x-realtime, so runtime is null — only assert the other 4 files */
	})

	it("round-trip: createUser + getUser", async () => {
		const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
		const dir = mkdtempSync(join(tmpdir(), "honey-ts-harness-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			for (const [key, filename] of Object.entries(FILE_NAMES)) {
				const content = files[key as keyof typeof files]
				if (content !== null && content !== undefined) writeFileSync(join(dir, filename), content, "utf8")
			}
			writeFileSync(join(dir, "tsconfig.json"), TSCONFIG, "utf8")

			const testRunner = `
import { MockSDK } from "./mock.index.gen"

const sdk = new MockSDK({ baseURL: process.env["BASE_URL"]!, throwOnError: true, headers: { Authorization: "Bearer valid-token" } })
const created = await sdk.createUser({ json: { name: "Alice", email: "a@b.com" } }) as { id: string; name: string; email: string }
const fetched = await sdk.getUser({ params: { id: created.id } }) as { id: string; name: string; email: string }
process.stdout.write(JSON.stringify({ created, fetched }) + "\\n")
`
			writeFileSync(join(dir, "test-runner.ts"), testRunner, "utf8")

			let stdout: string
			try {
				stdout = execSync("bun run test-runner.ts", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 15_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`bun run test-runner.ts failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as { created: { name: string; id: string }; fetched: { id: string } }
			expect(result.created.name).toBe("Alice")
			expect(result.fetched.id).toBe(result.created.id)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("onAuthExpired: 401 triggers callback, retries with new token", async () => {
		const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
		const dir = mkdtempSync(join(tmpdir(), "honey-ts-harness-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			for (const [key, filename] of Object.entries(FILE_NAMES)) {
				const content = files[key as keyof typeof files]
				if (content !== null && content !== undefined) writeFileSync(join(dir, filename), content, "utf8")
			}
			writeFileSync(join(dir, "tsconfig.json"), TSCONFIG, "utf8")

			const testRunner = `
import { MockSDK } from "./mock.index.gen"

let callCount = 0
const sdk = new MockSDK({
	baseURL: process.env["BASE_URL"]!,
	throwOnError: true,
	headers: { Authorization: "Bearer expired-token" },
	onAuthExpired: async () => { callCount++; return "valid-token" },
})
const user = await sdk.createUser({ json: { name: "Bob", email: "b@c.com" } }) as { id: string; name: string }
process.stdout.write(JSON.stringify({ name: user.name, callCount }) + "\\n")
`
			writeFileSync(join(dir, "test-runner.ts"), testRunner, "utf8")

			let stdout: string
			try {
				stdout = execSync("bun run test-runner.ts", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 15_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`bun run test-runner.ts failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as { name: string; callCount: number }
			expect(result.name).toBe("Bob")
			expect(result.callCount).toBe(1)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("onAuthExpired returns null: no retry, 401 propagated", async () => {
		const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
		const dir = mkdtempSync(join(tmpdir(), "honey-ts-harness-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			for (const [key, filename] of Object.entries(FILE_NAMES)) {
				const content = files[key as keyof typeof files]
				if (content !== null && content !== undefined) writeFileSync(join(dir, filename), content, "utf8")
			}
			writeFileSync(join(dir, "tsconfig.json"), TSCONFIG, "utf8")

			const testRunner = `
import { MockSDK } from "./mock.index.gen"

const sdk = new MockSDK({
	baseURL: process.env["BASE_URL"]!,
	throwOnError: true,
	headers: { Authorization: "Bearer expired-token" },
	onAuthExpired: async () => null,
})
let threw = false
let status = 0
try {
	await sdk.createUser({ json: { name: "Nope", email: "n@n.com" } })
} catch (e: unknown) {
	threw = true
	status = (e as { status?: number }).status ?? 0
}
process.stdout.write(JSON.stringify({ threw, status }) + "\\n")
`
			writeFileSync(join(dir, "test-runner.ts"), testRunner, "utf8")

			let stdout: string
			try {
				stdout = execSync("bun run test-runner.ts", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 15_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`bun run test-runner.ts failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as { threw: boolean; status: number }
			expect(result.threw).toBe(true)
			expect(result.status).toBe(401)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("no onAuthExpired config: 401 passes through without retry", async () => {
		const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
		const dir = mkdtempSync(join(tmpdir(), "honey-ts-harness-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			for (const [key, filename] of Object.entries(FILE_NAMES)) {
				const content = files[key as keyof typeof files]
				if (content !== null && content !== undefined) writeFileSync(join(dir, filename), content, "utf8")
			}
			writeFileSync(join(dir, "tsconfig.json"), TSCONFIG, "utf8")

			const testRunner = `
import { MockSDK } from "./mock.index.gen"

const sdk = new MockSDK({
	baseURL: process.env["BASE_URL"]!,
	throwOnError: true,
	headers: { Authorization: "Bearer expired-token" },
})
let threw = false
let status = 0
try {
	await sdk.createUser({ json: { name: "Nope", email: "n@n.com" } })
} catch (e: unknown) {
	threw = true
	status = (e as { status?: number }).status ?? 0
}
process.stdout.write(JSON.stringify({ threw, status }) + "\\n")
`
			writeFileSync(join(dir, "test-runner.ts"), testRunner, "utf8")

			let stdout: string
			try {
				stdout = execSync("bun run test-runner.ts", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 15_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`bun run test-runner.ts failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as { threw: boolean; status: number }
			expect(result.threw).toBe(true)
			expect(result.status).toBe(401)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("authHeaderName + authHeaderPrefix: custom header injection on retry", async () => {
		const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
		const dir = mkdtempSync(join(tmpdir(), "honey-ts-harness-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			for (const [key, filename] of Object.entries(FILE_NAMES)) {
				const content = files[key as keyof typeof files]
				if (content !== null && content !== undefined) writeFileSync(join(dir, filename), content, "utf8")
			}
			writeFileSync(join(dir, "tsconfig.json"), TSCONFIG, "utf8")

			const testRunner = `
import { MockSDK } from "./mock.index.gen"

let callCount = 0
const sdk = new MockSDK({
	baseURL: process.env["BASE_URL"]!,
	throwOnError: true,
	headers: { Authorization: "Bearer expired-token" },
	authHeaderName: "Authorization",
	authHeaderPrefix: "Bearer ",
	onAuthExpired: async () => { callCount++; return "valid-token" },
})
const user = await sdk.createUser({ json: { name: "Custom", email: "c@c.com" } }) as { id: string; name: string }
process.stdout.write(JSON.stringify({ name: user.name, callCount }) + "\\n")
`
			writeFileSync(join(dir, "test-runner.ts"), testRunner, "utf8")

			let stdout: string
			try {
				stdout = execSync("bun run test-runner.ts", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 15_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`bun run test-runner.ts failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as { name: string; callCount: number }
			expect(result.name).toBe("Custom")
			expect(result.callCount).toBe(1)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("typed error hierarchy — known status maps to subclass", async () => {
		const testRunner = `
import {
	MockSDK,
	ClientError,
	BadRequestError,
	UnauthorizedError,
	NotFoundError,
	InternalServerError,
	RateLimitError,
} from "./mock.index.gen"

const sdk = new MockSDK({ baseURL: process.env["BASE_URL"]!, throwOnError: true })

const cases: Array<{ status: number; ctor: new (...args: any[]) => Error; expectedName: string }> = [
	{ status: 400, ctor: BadRequestError, expectedName: "BadRequestError" },
	{ status: 401, ctor: UnauthorizedError, expectedName: "UnauthorizedError" },
	{ status: 404, ctor: NotFoundError, expectedName: "NotFoundError" },
	{ status: 500, ctor: InternalServerError, expectedName: "InternalServerError" },
	{ status: 429, ctor: RateLimitError, expectedName: "RateLimitError" },
]

const results: Array<{ status: number; name: string; isSubclass: boolean; isClientError: boolean; gotStatus: number }> = []
for (const c of cases) {
	try {
		await sdk.getError({ params: { status: c.status } })
		results.push({ status: c.status, name: "NO_THROW", isSubclass: false, isClientError: false, gotStatus: 0 })
	} catch (e: unknown) {
		const err = e as Error & { status?: number }
		results.push({
			status: c.status,
			name: err.name,
			isSubclass: e instanceof c.ctor,
			isClientError: e instanceof ClientError,
			gotStatus: err.status ?? 0,
		})
	}
}
process.stdout.write(JSON.stringify(results) + "\\n")
`
		const results = (await runErrorHarnessScript(spec, testRunner)) as Array<{
			status: number
			name: string
			isSubclass: boolean
			isClientError: boolean
			gotStatus: number
		}>
		expect(results).toHaveLength(5)
		const expected: Record<number, string> = {
			400: "BadRequestError",
			401: "UnauthorizedError",
			404: "NotFoundError",
			429: "RateLimitError",
			500: "InternalServerError",
		}
		for (const r of results) {
			expect(r.name).toBe(expected[r.status])
			expect(r.isSubclass).toBe(true)
			expect(r.isClientError).toBe(true)
			expect(r.gotStatus).toBe(r.status)
		}
	})

	it("typed error hierarchy — unknown status falls back to base ClientError", async () => {
		const testRunner = `
import { MockSDK, ClientError } from "./mock.index.gen"

const sdk = new MockSDK({ baseURL: process.env["BASE_URL"]!, throwOnError: true })

let result: { errName: string; isClientError: boolean; isExactClientError: boolean; status: number; threw: boolean } = {
	errName: "NO_THROW",
	isClientError: false,
	isExactClientError: false,
	status: 0,
	threw: false,
}
try {
	await sdk.getError({ params: { status: 418 } })
} catch (e: unknown) {
	const err = e as Error & { status?: number }
	result = {
		errName: err.name,
		isClientError: e instanceof ClientError,
		isExactClientError: (e as { constructor: unknown }).constructor === ClientError,
		status: err.status ?? 0,
		threw: true,
	}
}
process.stdout.write(JSON.stringify(result) + "\\n")
`
		const result = (await runErrorHarnessScript(spec, testRunner)) as {
			errName: string
			isClientError: boolean
			isExactClientError: boolean
			status: number
			threw: boolean
		}
		expect(result.threw).toBe(true)
		expect(result.isClientError).toBe(true)
		expect(result.isExactClientError).toBe(true)
		expect(result.errName).toBe("ClientError")
		expect(result.status).toBe(418)
	})

	it("Test K — typed error data: 400 parses into typed data field", async () => {
		const testRunner = `
import { MockSDK, BadRequestError, ClientError } from "./mock.index.gen"

const sdk = new MockSDK({ baseURL: process.env["BASE_URL"]!, throwOnError: true })

let result: {
	threw: boolean
	name: string
	status: number
	isBadRequest: boolean
	isClientError: boolean
	dataType: string
	dataIsObject: boolean
	dataStatus: number | null
	dataMessage: string | null
	bodyType: string
	bodyStatus: number | null
} = {
	threw: false,
	name: "NO_THROW",
	status: 0,
	isBadRequest: false,
	isClientError: false,
	dataType: "missing",
	dataIsObject: false,
	dataStatus: null,
	dataMessage: null,
	bodyType: "missing",
	bodyStatus: null,
}
try {
	await sdk.getDeclaredError({ params: { status: "400" } })
} catch (e: unknown) {
	const err = e as Error & { status?: number; data?: unknown; body?: unknown }
	const data = err.data as { status?: number; message?: string } | undefined
	const body = err.body as { status?: number } | undefined
	result = {
		threw: true,
		name: err.name,
		status: err.status ?? 0,
		isBadRequest: e instanceof BadRequestError,
		isClientError: e instanceof ClientError,
		dataType: typeof err.data,
		dataIsObject: typeof err.data === "object" && err.data !== null,
		dataStatus: data?.status ?? null,
		dataMessage: data?.message ?? null,
		bodyType: typeof err.body,
		bodyStatus: typeof body === "object" && body !== null ? (body.status ?? null) : null,
	}
}
process.stdout.write(JSON.stringify(result) + "\\n")
`
		const result = (await runErrorHarnessScript(spec, testRunner)) as {
			threw: boolean
			name: string
			status: number
			isBadRequest: boolean
			isClientError: boolean
			dataType: string
			dataIsObject: boolean
			dataStatus: number | null
			dataMessage: string | null
			bodyType: string
			bodyStatus: number | null
		}
		expect(result.threw).toBe(true)
		expect(result.name).toBe("BadRequestError")
		expect(result.status).toBe(400)
		expect(result.isBadRequest).toBe(true)
		expect(result.isClientError).toBe(true)
		/* RED gate: emitted _ClientError lacks `data` field — parsed payload only on `body` today */
		expect(result.dataIsObject).toBe(true)
		expect(result.dataType).toBe("object")
		expect(result.dataStatus).toBe(400)
		expect(result.dataMessage).toBe("Bad Request")
	})

	it("Test S — per-call timeout overrides config timeout (aborts before slow response)", async () => {
		const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
		const dir = mkdtempSync(join(tmpdir(), "honey-ts-harness-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			for (const [key, filename] of Object.entries(FILE_NAMES)) {
				const content = files[key as keyof typeof files]
				if (content !== null && content !== undefined) writeFileSync(join(dir, filename), content, "utf8")
			}
			writeFileSync(join(dir, "tsconfig.json"), TSCONFIG, "utf8")

			const testRunner = `
import { MockSDK } from "./mock.index.gen"

const sdk = new MockSDK({ baseURL: process.env["BASE_URL"]!, throwOnError: true, timeout: 10_000 })
const start = Date.now()
let threw = false
let errMsg = ""
try {
	await sdk.slow({ search: { ms: 200 }, timeout: 50 })
} catch (e: unknown) {
	threw = true
	errMsg = (e as Error).message
}
const elapsed = Date.now() - start
process.stdout.write(JSON.stringify({ threw, errMsg, elapsed }) + "\\n")
`
			writeFileSync(join(dir, "test-runner.ts"), testRunner, "utf8")

			let stdout: string
			try {
				stdout = execSync("bun run test-runner.ts", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 15_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`bun run test-runner.ts failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as { threw: boolean; errMsg: string; elapsed: number }
			expect(result.threw).toBe(true)
			/* per-call (50ms) wins, must abort well before mock's 200ms delay */
			expect(result.elapsed).toBeLessThan(180)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("Test T — per-call timeout absent: config-level timeout applies, slow request succeeds", async () => {
		const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
		const dir = mkdtempSync(join(tmpdir(), "honey-ts-harness-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			for (const [key, filename] of Object.entries(FILE_NAMES)) {
				const content = files[key as keyof typeof files]
				if (content !== null && content !== undefined) writeFileSync(join(dir, filename), content, "utf8")
			}
			writeFileSync(join(dir, "tsconfig.json"), TSCONFIG, "utf8")

			const testRunner = `
import { MockSDK } from "./mock.index.gen"

const sdk = new MockSDK({ baseURL: process.env["BASE_URL"]!, throwOnError: true, timeout: 10_000 })
const result = await sdk.slow({ search: { ms: 50 } }) as { ok: boolean }
process.stdout.write(JSON.stringify(result) + "\\n")
`
			writeFileSync(join(dir, "test-runner.ts"), testRunner, "utf8")

			let stdout: string
			try {
				stdout = execSync("bun run test-runner.ts", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 15_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`bun run test-runner.ts failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as { ok: boolean }
			expect(result.ok).toBe(true)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("Test L1 — onLog emits request_start + response_received entries with correct shape", async () => {
		const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
		const dir = mkdtempSync(join(tmpdir(), "honey-ts-harness-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			for (const [key, filename] of Object.entries(FILE_NAMES)) {
				const content = files[key as keyof typeof files]
				if (content !== null && content !== undefined) writeFileSync(join(dir, filename), content, "utf8")
			}
			writeFileSync(join(dir, "tsconfig.json"), TSCONFIG, "utf8")

			const testRunner = `
import { MockSDK } from "./mock.index.gen"

const entries: unknown[] = []
const sdk = new MockSDK({
	baseURL: process.env["BASE_URL"]!,
	throwOnError: true,
	headers: { Authorization: "Bearer valid-token" },
	onLog: (e) => { entries.push(e) },
})
await sdk.createUser({ json: { name: "Log", email: "l@l.com" } })
process.stdout.write(JSON.stringify(entries) + "\\n")
`
			writeFileSync(join(dir, "test-runner.ts"), testRunner, "utf8")

			let stdout: string
			try {
				stdout = execSync("bun run test-runner.ts", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 15_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`bun run test-runner.ts failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const entries = JSON.parse(stdout.trim()) as Array<{
				level: string
				event: string
				operation: string
				duration_ms: number
				status?: number
			}>
			expect(entries).toHaveLength(2)
			expect(entries[0]?.event).toBe("request_start")
			expect(entries[0]?.level).toBe("debug")
			expect(entries[0]?.operation).toBe("POST /users")
			expect(entries[0]?.duration_ms).toBe(0)
			expect(entries[1]?.event).toBe("response_received")
			expect(entries[1]?.level).toBe("info")
			expect(entries[1]?.operation).toBe("POST /users")
			expect(entries[1]?.status).toBe(201)
			expect(Number.isFinite(entries[1]?.duration_ms)).toBe(true)
			expect(entries[1]?.duration_ms).toBeGreaterThanOrEqual(0)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("isClientError predicate works for typed subclasses", async () => {
		const testRunner = `
import { MockSDK, isClientError, UnprocessableEntityError } from "./mock.index.gen"

const sdk = new MockSDK({ baseURL: process.env["BASE_URL"]!, throwOnError: true })

let result: { isClientErr: boolean; isSubclass: boolean; status: number; threw: boolean } = {
	isClientErr: false,
	isSubclass: false,
	status: 0,
	threw: false,
}
try {
	await sdk.getError({ params: { status: 422 } })
} catch (e: unknown) {
	const err = e as Error & { status?: number }
	result = {
		isClientErr: isClientError(e),
		isSubclass: e instanceof UnprocessableEntityError,
		status: err.status ?? 0,
		threw: true,
	}
}
process.stdout.write(JSON.stringify(result) + "\\n")
`
		const result = (await runErrorHarnessScript(spec, testRunner)) as {
			isClientErr: boolean
			isSubclass: boolean
			status: number
			threw: boolean
		}
		expect(result.threw).toBe(true)
		expect(result.isClientErr).toBe(true)
		expect(result.isSubclass).toBe(true)
		expect(result.status).toBe(422)
	})

	it("Test 7.a.2 — streaming upload (ReadableStream, 1MB) returns matching size + sha256", async () => {
		const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
		const dir = mkdtempSync(join(tmpdir(), "honey-ts-harness-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			for (const [key, filename] of Object.entries(FILE_NAMES)) {
				const content = files[key as keyof typeof files]
				if (content !== null && content !== undefined) writeFileSync(join(dir, filename), content, "utf8")
			}
			writeFileSync(join(dir, "tsconfig.json"), TSCONFIG, "utf8")

			const testRunner = `
import { createHash } from "node:crypto"
import { MockSDK } from "./mock.index.gen"

const total = 1024 * 1024
const chunkSize = 64 * 1024
const hasher = createHash("sha256")
let sent = 0
const stream = new ReadableStream<Uint8Array>({
	pull(controller) {
		if (sent >= total) { controller.close(); return }
		const len = Math.min(chunkSize, total - sent)
		const chunk = new Uint8Array(len)
		for (let i = 0; i < len; i++) chunk[i] = (sent + i) & 0xff
		hasher.update(chunk)
		sent += len
		controller.enqueue(chunk)
	},
})
const sdk = new MockSDK({ baseURL: process.env["BASE_URL"]!, throwOnError: true, headers: { Authorization: "Bearer valid-token" } })
const result = await sdk.uploadBlob({ body: stream }) as { size: number; hash: string }
const expected = hasher.digest("hex")
process.stdout.write(JSON.stringify({ size: result.size, hash: result.hash, expected, total }) + "\\n")
`
			writeFileSync(join(dir, "test-runner.ts"), testRunner, "utf8")

			let stdout: string
			try {
				stdout = execSync("bun run test-runner.ts", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 20_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`bun run test-runner.ts failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as {
				size: number
				hash: string
				expected: string
				total: number
			}
			expect(result.size).toBe(result.total)
			expect(result.hash).toBe(result.expected)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("Test 8.d.1 — ResumableConnection drops mid-stream, reconnects via alternate TransportAdapter, resumes events", async () => {
		const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
		const dir = mkdtempSync(join(tmpdir(), "honey-ts-harness-8d1-"))
		try {
			for (const [key, filename] of Object.entries(FILE_NAMES)) {
				const content = files[key as keyof typeof files]
				if (content !== null && content !== undefined) writeFileSync(join(dir, filename), content, "utf8")
			}
			writeFileSync(join(dir, "tsconfig.json"), TSCONFIG, "utf8")

			const testRunner = `
import {
	createResumableConnection,
	type TransportAdapter,
	type TransportConnection,
	type TransportOpts,
	type ServerFrame,
} from "./mock.runtime.gen"

let flakyCalls = 0
let stableCalls = 0

function makeFlakyAdapter(): TransportAdapter {
	return {
		connect(_url: string, _opts: TransportOpts): TransportConnection {
			flakyCalls += 1
			const call = flakyCalls
			let onFrameCb: (frame: ServerFrame) => void = () => {}
			let onCloseCb: (reason: string) => void = () => {}
			let onErrorCb: (err: unknown) => void = () => {}
			const conn: TransportConnection = {
				send(_data: string) {},
				close() {},
				get onFrame() { return onFrameCb },
				set onFrame(cb) { onFrameCb = cb },
				get onClose() { return onCloseCb },
				set onClose(cb) { onCloseCb = cb },
				get onError() { return onErrorCb },
				set onError(cb) { onErrorCb = cb },
			}
			queueMicrotask(() => {
				if (call === 1) {
					onFrameCb({ t: "ready", reconnectToken: "rt-flaky" })
					queueMicrotask(() => {
						onFrameCb({ t: "msg", id: 1, data: { src: "A", seq: 1 } })
						queueMicrotask(() => {
							onErrorCb(new Error("simulated mid-stream drop"))
						})
					})
				} else {
					/* subsequent dials of the flaky adapter fail fast so the chain
					 * falls through to the stable adapter deterministically. */
					onErrorCb(new Error("flaky adapter refuses reconnect"))
				}
			})
			return conn
		},
	}
}

function makeStableAdapter(): TransportAdapter {
	return {
		connect(_url: string, _opts: TransportOpts): TransportConnection {
			stableCalls += 1
			let onFrameCb: (frame: ServerFrame) => void = () => {}
			let onCloseCb: (reason: string) => void = () => {}
			let onErrorCb: (err: unknown) => void = () => {}
			const conn: TransportConnection = {
				send(_data: string) {},
				close() {},
				get onFrame() { return onFrameCb },
				set onFrame(cb) { onFrameCb = cb },
				get onClose() { return onCloseCb },
				set onClose(cb) { onCloseCb = cb },
				get onError() { return onErrorCb },
				set onError(cb) { onErrorCb = cb },
			}
			queueMicrotask(() => {
				onFrameCb({ t: "ready", reconnectToken: "rt-stable" })
				queueMicrotask(() => {
					onFrameCb({ t: "msg", id: 1, data: { src: "B", seq: 1 } })
					queueMicrotask(() => {
						onFrameCb({ t: "msg", id: 2, data: { src: "B", seq: 2 } })
					})
				})
			})
			return conn
		},
	}
}

const rc = createResumableConnection({
	maxReconnectAttempts: 5,
	reconnectDelayMs: 10,
	transports: [makeFlakyAdapter(), makeStableAdapter()],
	url: "http://test.local/rt",
})

const events: Array<{ src: string; seq: number }> = []
const deadline = new Promise<never>((_res, rej) => {
	setTimeout(() => rej(new Error("timed out waiting for 3 events")), 5000)
})

async function drain() {
	for await (const ev of rc) {
		events.push(ev as { src: string; seq: number })
		if (events.length === 3) return
	}
}

await Promise.race([drain(), deadline])

const proven = rc.provenTransport
rc.close()

process.stdout.write(JSON.stringify({
	events,
	flakyCalls,
	stableCalls,
	proven,
	closedState: rc.state,
}) + "\\n")
`
			writeFileSync(join(dir, "test-runner.ts"), testRunner, "utf8")

			let stdout: string
			try {
				stdout = execSync("bun run test-runner.ts", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env },
					timeout: 15_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`bun run test-runner.ts failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const parsed = JSON.parse(stdout.trim()) as {
				events: Array<{ src: string; seq: number }>
				flakyCalls: number
				stableCalls: number
				proven: string
				closedState: string
			}
			expect(parsed.events).toHaveLength(3)
			expect(parsed.events[0]).toEqual({ seq: 1, src: "A" })
			expect(parsed.events[1]).toEqual({ seq: 1, src: "B" })
			expect(parsed.events[2]).toEqual({ seq: 2, src: "B" })
			/* flaky adapter dialled twice: once for initial connect, once during
			 * reconnect chain (refuses second time → chain falls to stable). */
			expect(parsed.flakyCalls).toBe(2)
			expect(parsed.stableCalls).toBe(1)
			/* createFallbackChain labels proven by index position (codegen.ts ~3240-3260),
			 * so adapter-at-index-1 → "sse". */
			expect(parsed.proven).toBe("sse")
			expect(parsed.closedState).toBe("closed")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test 8.d.2 — createFallbackChain with a single custom TransportAdapter yields a ready frame", async () => {
		const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
		const dir = mkdtempSync(join(tmpdir(), "honey-ts-harness-8d2-"))
		try {
			for (const [key, filename] of Object.entries(FILE_NAMES)) {
				const content = files[key as keyof typeof files]
				if (content !== null && content !== undefined) writeFileSync(join(dir, filename), content, "utf8")
			}
			writeFileSync(join(dir, "tsconfig.json"), TSCONFIG, "utf8")

			const testRunner = `
import {
	createFallbackChain,
	type TransportAdapter,
	type TransportConnection,
	type TransportOpts,
	type ServerFrame,
} from "./mock.runtime.gen"

let connectCalls = 0

function makeCustomAdapter(): TransportAdapter {
	return {
		connect(_url: string, _opts: TransportOpts): TransportConnection {
			connectCalls += 1
			let onFrameCb: (frame: ServerFrame) => void = () => {}
			let onCloseCb: (reason: string) => void = () => {}
			let onErrorCb: (err: unknown) => void = () => {}
			const conn: TransportConnection = {
				send(_data: string) {},
				close() {},
				get onFrame() { return onFrameCb },
				set onFrame(cb) { onFrameCb = cb },
				get onClose() { return onCloseCb },
				set onClose(cb) { onCloseCb = cb },
				get onError() { return onErrorCb },
				set onError(cb) { onErrorCb = cb },
			}
			queueMicrotask(() => {
				onFrameCb({ t: "ready", reconnectToken: "rt-custom" })
			})
			return conn
		},
	}
}

const chain = createFallbackChain({ transports: [makeCustomAdapter()] })
const { transport } = await chain.connect("http://test.local/rt", {})
process.stdout.write(JSON.stringify({
	transport,
	proven: chain.provenTransport,
	connectCalls,
}) + "\\n")
`
			writeFileSync(join(dir, "test-runner.ts"), testRunner, "utf8")

			let stdout: string
			try {
				stdout = execSync("bun run test-runner.ts", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env },
					timeout: 15_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`bun run test-runner.ts failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as {
				transport: string
				proven: string
				connectCalls: number
			}
			/* TS chain currently labels proven by index position (codegen.ts ~3240-3248),
			 * not adapter.kind(). Single-adapter chain → index 0 → "ws". Relevant
			 * invariant: custom adapter's connect() was invoked and the chain
			 * resolved against it. Cross-lang kind()-based proven alignment is a
			 * follow-up outside 8.d. */
			expect(result.transport).toBe("ws")
			expect(result.proven).toBe("ws")
			expect(result.connectCalls).toBe(1)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("Test 9.a.2 — x-idempotency-key: auto-UUID header when caller omits, echoes explicit key", async () => {
		const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
		const dir = mkdtempSync(join(tmpdir(), "honey-ts-harness-9a2-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			for (const [key, filename] of Object.entries(FILE_NAMES)) {
				const content = files[key as keyof typeof files]
				if (content !== null && content !== undefined) writeFileSync(join(dir, filename), content, "utf8")
			}
			writeFileSync(join(dir, "tsconfig.json"), TSCONFIG, "utf8")

			const testRunner = `
import { MockSDK } from "./mock.index.gen"

const sdk = new MockSDK({ baseURL: process.env["BASE_URL"]!, throwOnError: true })
const auto = await sdk.idempotentCreate() as { idempotencyKey: string }
const explicit = await sdk.idempotentCreate({ idempotencyKey: "user-supplied-key-123" }) as { idempotencyKey: string }
const viaHeader = await sdk.idempotentCreate({ headers: { "Idempotency-Key": "header-wins-456" } }) as { idempotencyKey: string }
process.stdout.write(JSON.stringify({ auto: auto.idempotencyKey, explicit: explicit.idempotencyKey, viaHeader: viaHeader.idempotencyKey }) + "\\n")
`
			writeFileSync(join(dir, "test-runner.ts"), testRunner, "utf8")

			let stdout: string
			try {
				stdout = execSync("bun run test-runner.ts", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 15_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`bun run test-runner.ts failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as { auto: string; explicit: string; viaHeader: string }
			/* auto → UUID v4 shape emitted by crypto.randomUUID() */
			expect(result.auto).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
			/* explicit opts.idempotencyKey → echoed verbatim */
			expect(result.explicit).toBe("user-supplied-key-123")
			/* headers["Idempotency-Key"] wins over opts.idempotencyKey + auto */
			expect(result.viaHeader).toBe("header-wins-456")
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	})

	/* ------------------------------------------------------------------
	 * Phase 10 — WebSocket behavioural audit (10.a.1)
	 * Four shared behaviours: connect+echo, client-close, server-close,
	 * auth handshake via ?token=. Ping/pong SCOPED OUT (auto-handled by
	 * every lib, never surfaces to user-space).
	 * ------------------------------------------------------------------ */

	async function runWsScript(testRunner: string): Promise<unknown> {
		const { files } = generateSDK(spec, { name: "MockSDK", stem: STEM })
		const dir = mkdtempSync(join(tmpdir(), "honey-ts-harness-ws-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			for (const [key, filename] of Object.entries(FILE_NAMES)) {
				const content = files[key as keyof typeof files]
				if (content !== null && content !== undefined) writeFileSync(join(dir, filename), content, "utf8")
			}
			writeFileSync(join(dir, "tsconfig.json"), TSCONFIG, "utf8")
			writeFileSync(join(dir, "test-runner.ts"), testRunner, "utf8")

			let stdout: string
			try {
				stdout = execSync("bun run test-runner.ts", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 15_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`bun run test-runner.ts failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			return JSON.parse(stdout.trim())
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}

	it("Test 10.a.1 WS-A — connect + send + recv echo", async () => {
		const testRunner = `
import { MockSDK } from "./mock.index.gen"

const sdk = new MockSDK({ baseURL: process.env["BASE_URL"]!, throwOnError: true })
const ws = sdk.connectWs()
await new Promise<void>((resolve) => { ws.on("open", () => resolve()) })
const received: string[] = []
ws.on("message", (data: string) => { received.push(data); if (received.length === 1) ws.close(1000, "done") })
await new Promise<void>((resolve) => { ws.on("close", () => resolve()); ws.send("hello") })
process.stdout.write(JSON.stringify({ received }) + "\\n")
`
		const result = (await runWsScript(testRunner)) as { received: string[] }
		expect(result.received).toEqual(["hello"])
	})

	it("Test 10.a.1 WS-B — client-initiated close surfaces close event", async () => {
		const testRunner = `
import { MockSDK } from "./mock.index.gen"

const sdk = new MockSDK({ baseURL: process.env["BASE_URL"]!, throwOnError: true })
const ws = sdk.connectWs()
await new Promise<void>((resolve) => { ws.on("open", () => resolve()) })
const closeInfo = await new Promise<{ code: number; reason: string }>((resolve) => {
	ws.on("close", (code: number, reason: string) => resolve({ code, reason }))
	ws.close(1000, "client-bye")
})
process.stdout.write(JSON.stringify(closeInfo) + "\\n")
`
		const result = (await runWsScript(testRunner)) as { code: number; reason: string }
		/* client-initiated close: bun WebSocket surfaces code (1000) on close event.
		 * `reason` is not reliably round-tripped across all WS impls (server's echo
		 * is optional per RFC 6455 §5.5.1) — assert code only. */
		expect(result.code).toBe(1000)
	})

	it("Test 10.a.1 WS-C — server-initiated close detected", async () => {
		const testRunner = `
import { MockSDK } from "./mock.index.gen"

const sdk = new MockSDK({ baseURL: process.env["BASE_URL"]!, throwOnError: true })
const ws = sdk.connectWs()
await new Promise<void>((resolve) => { ws.on("open", () => resolve()) })
const closeInfo = await new Promise<{ code: number; reason: string }>((resolve) => {
	ws.on("close", (code: number, reason: string) => resolve({ code, reason }))
	ws.send("__close__")
})
process.stdout.write(JSON.stringify(closeInfo) + "\\n")
`
		const result = (await runWsScript(testRunner)) as { code: number; reason: string }
		expect(result.code).toBe(1000)
		expect(result.reason).toBe("server-initiated")
	})

	it("Test 10.a.1 WS-D — auth handshake via ?token= query-param", async () => {
		const testRunner = `
import { MockSDK } from "./mock.index.gen"

const sdk = new MockSDK({ baseURL: process.env["BASE_URL"]!, throwOnError: true })

async function runCase(token: string): Promise<{ token: string; closeCode: number; echoed: string[] }> {
	const ws = sdk.connectWs({ search: { token } })
	await new Promise<void>((resolve) => { ws.on("open", () => resolve()) })
	const echoed: string[] = []
	ws.on("message", (data: string) => { echoed.push(data); if (echoed.length === 1) ws.close(1000, "done") })
	const closeInfo = await new Promise<{ code: number }>((resolve) => {
		ws.on("close", (code: number) => resolve({ code }))
		ws.send("ping")
	})
	return { token, closeCode: closeInfo.code, echoed }
}

const ok = await runCase("valid-token")
const bad = await runCase("bogus-token")
process.stdout.write(JSON.stringify({ ok, bad }) + "\\n")
`
		const result = (await runWsScript(testRunner)) as {
			ok: { token: string; closeCode: number; echoed: string[] }
			bad: { token: string; closeCode: number; echoed: string[] }
		}
		/* good token → echo happens, client-initiated close code 1000 */
		expect(result.ok.echoed).toEqual(["ping"])
		expect(result.ok.closeCode).toBe(1000)
		/* bad token → server closes before echo; code 4401 (app-level policy violation) */
		expect(result.bad.echoed).toEqual([])
		expect(result.bad.closeCode).toBe(4401)
	})

	/* Ping/pong: auto-handled by every underlying lib (browser WebSocket,
	 * Python websockets, nhooyr.io/websocket, tokio-tungstenite), not
	 * exposed to user-space. Out of scope per master spec §11. BLOCKER if
	 * exposed later. */
	it.skip("Test 10.a.1 WS-E — ping/pong auto-handled (not user-observable)", () => {})
})
