/**
 * Every runtime byte lock's ledger is current (bit 21 i7e, G14): each lock is the exact bytes its runtime ships, so
 * any change, a raise or a cut, moves the constant; this holds the comment above it to move with it. The ledger's
 * last entry ends `to <figure>`, and that figure is the lock. A silent raise would leave the two apart, and a cut
 * that left stale headroom cannot happen at all now that each byte leg asserts its runtime's exact bytes.
 *
 * The figure is comma-grouped (`to 99,240 B`), which is how every entry writes it and what tells it apart from the
 * numbers an entry's prose names (`its status 300 to 599`).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const SCRIPTS = import.meta.dirname

/** Each byte lock: the file that holds it and its name. A lock outside this list is caught by the completeness leg. */
export const LOCKS: readonly (readonly [string, string])[] = [
	["sdk-budget.test.ts", "GO_RUNTIME_BYTES"],
	["sdk-budget.test.ts", "RUST_RUNTIME_BYTES"],
	["sdk-budget.test.ts", "PYTHON_RUNTIME_BYTES"],
	["sdk-budget.test.ts", "CSHARP_RUNTIME_BYTES"],
	["sdk-budget.test.ts", "TS_RUNTIME_BYTES"],
	["sdk-budget.java.test.ts", "JAVA_RUNTIME_BYTES"],
	["sdk-budget.cli.test.ts", "CLI_RUNTIME_BYTES"],
	["sdk-budget.mcp.test.ts", "MCP_PORTABLE_BYTES"],
	["sdk-budget.mcp.test.ts", "MCP_NODE_BYTES"],
]

/**
 * The lock `name` holds in `source` and the last figure its ledger reaches: the block comment directly above it,
 * nothing but whitespace between. A lock with no ledger above it, or a ledger that reaches no figure, throws, so
 * neither passes by going unread.
 */
export function ledgerOf(source: string, name: string): { readonly lock: number; readonly reaches: number } {
	const declared = new RegExp(`^const ${name} = ([\\d_]+)$`, "m").exec(source)
	if (declared === null) throw new Error(`${name}: no lock to read`)
	const above = source.slice(0, declared.index)
	const ledger = [...above.matchAll(/\/\*[\s\S]*?\*\//g)].at(-1)
	if (ledger === undefined || above.slice(ledger.index + ledger[0].length).trim() !== "")
		throw new Error(`${name}: no ledger directly above it`)
	const reached = [...ledger[0].matchAll(/\bto (\d{1,3}(?:,\d{3})+)\b/g)].at(-1)
	if (reached === undefined) throw new Error(`${name}: its ledger reaches no figure`)
	return {
		lock: Number((declared[1] as string).replaceAll("_", "")),
		reaches: Number((reached[1] as string).replaceAll(",", "")),
	}
}

const read = (file: string) => readFileSync(join(SCRIPTS, file), "utf8")

describe("each runtime byte lock's ledger reaches it (bit 21 i7e, G14)", () => {
	it("reads the lock and the figure its ledger reaches, and refuses a lock with neither", () => {
		const page = "/*\n * Bit 1, +9 B to 1,009 B: a feature.\n */\nconst A_BYTES = 1_009\nconst B_BYTES = 7\n"
		expect(ledgerOf(page, "A_BYTES")).toEqual({ lock: 1009, reaches: 1009 })
		expect(() => ledgerOf(page, "C_BYTES")).toThrow("C_BYTES: no lock to read")
		expect(() => ledgerOf(page, "B_BYTES")).toThrow("B_BYTES: no ledger directly above it")
		expect(() => ledgerOf("/* a lock of 300 to 599 */\nconst D_BYTES = 9", "D_BYTES")).toThrow(
			"D_BYTES: its ledger reaches no figure",
		)
	})

	it("holds every byte lock in the scripts, none outside the list", () => {
		const found = LOCKS.map(([file]) => file)
			.filter((file, at, files) => files.indexOf(file) === at)
			.flatMap((file) => [...read(file).matchAll(/^const (\w+_BYTES) = /gm)].map((match) => match[1] as string))
			.sort()
		expect(found).toEqual(LOCKS.map(([, name]) => name).sort())
	})

	it("reaches each lock's own figure, so a lock that moves moves its ledger", () => {
		const apart = LOCKS.map(([file, name]) => [name, ledgerOf(read(file), name)] as const).filter(
			([, { lock, reaches }]) => lock !== reaches,
		)
		expect(apart).toEqual([])
	})
})
