/**
 * Consumer programs (contract 28 §6.4): an `async def main` around a test's Python body, run against a registry
 * SDK's package (compiledPython) for what a JSON driver cannot fill, and `checked`, mypy's findings for a program
 * against it, for what only type checking proves (a name, a type, a signature). The program reads `{base}` from
 * stdin, so a body may aim a client at the shared recording server (`served()`,
 * emit/shared/__fixtures__/recording-server.ts), and prints every section's notes as one JSON object. Test
 * programs are never ruff-gated and never shipped.
 */
import { compiledPython } from "./compiled.ts"
import type { FixtureKey } from "./documents.ts"

/**
 * The program around `{{body}}`: `section(s)` starts a section, `note(line)` adds to it, `client()` and
 * `aclient()` are the SDK's clients aimed at `BASE`, which is `input["base"]` (an unroutable address without one).
 */
const PROGRAM = `# consumer {{name}}: a test program, never shipped
import asyncio
import json
import sys

sys.path.insert(0, sys.argv[1])
import {{package}} as sdk

OUT: dict[str, list[str]] = {}
AT = ["main"]


def section(name: str) -> None:
    AT[0] = name


def note(line: object) -> None:
    OUT.setdefault(AT[0], []).append(line if isinstance(line, str) else json.dumps(line, sort_keys=True))


INPUT = json.loads(sys.stdin.read() or "null") or {}
BASE = INPUT.get("base", "http://127.0.0.1:9")


def client(**config: object) -> sdk.SDK:
    return sdk.SDK(sdk.ClientConfig(base_url=BASE, **config))


def aclient(**config: object) -> sdk.AsyncSDK:
    return sdk.AsyncSDK(sdk.ClientConfig(base_url=BASE, **config))


async def main() -> None:
{{body}}


asyncio.run(main())
print(json.dumps(OUT))
`

/** A consumer program: its body (statements of `main`, unindented), and the base on its stdin. */
export type Consumer = { readonly base?: string; readonly body: string }

/** A consumer program's run: whether it ran to the end, its notes by section, its stderr. */
export type Run = { ran: boolean; stderr: string; out: Record<string, string[]> | undefined }

/** PROGRAM named `name` around `body`, each line indented into `main`, importing `pkg` as `sdk`. */
export function program(pkg: string, name: string, body: string): string {
	const indented = body
		.split("\n")
		.map((line) => (line === "" ? "" : `    ${line}`))
		.join("\n")
	return PROGRAM.replace("{{name}}", () => name)
		.replace("{{package}}", () => pkg)
		.replace("{{body}}", () => (indented.trim() === "" ? "    pass" : indented))
}

/** The registry SDK `key` with the consumer `p` run against it as program `name`, `{base}` on its stdin, without blocking the event loop. */
export async function consume(key: FixtureKey, name: string, p: Consumer): Promise<Run> {
	const sdk = compiledPython(key)
	if (!sdk.imported) return { out: undefined, ran: false, stderr: sdk.stderr }
	const ran = await sdk.exec(
		program(sdk.package, name, p.body),
		JSON.stringify(p.base === undefined ? {} : { base: p.base }),
	)
	const out = ran.status === 0 ? (JSON.parse(ran.stdout) as Record<string, string[]>) : undefined
	return { out, ran: ran.status === 0, stderr: ran.stderr }
}

/** mypy's findings under MYPY_FLAGS for `program` against the registry SDK `key` (one run per program text). */
export const checked = (key: FixtureKey, source: string): readonly string[] => compiledPython(key).check(source)

/** `run` run once, on first use. */
export function once<T>(run: () => Promise<T>): () => Promise<T> {
	let memo: Promise<T> | undefined
	return () => (memo ??= run())
}

/** What a test asserts of a run: it ran, and the notes of `section`. */
export const seen = (run: Run, section = "main") => ({ ran: run.ran, out: run.out?.[section] })
