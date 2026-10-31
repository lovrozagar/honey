/**
 * The two CLIs' argument rules held alike (bit 19 h1): core's `honey` (src/build/cli-args.ts) and honey-clients's
 * generate (gen src/gen/args.ts) each parse their own flags, since core needs no codegen to run `honey init` and gen
 * never imports core (H2); this table runs one rule through both, a value flag standing as `<V>` and a boolean as
 * `--watch`. Test-only, gen is imported by path, as codegen-tables.test.ts does.
 */
import { describe, expect, it } from "vitest"
import { parseGenerate } from "../../../gen/src/gen/args.ts"
import { parseGenerateArgs } from "../../src/build/cli-args.ts"

/** gen's required flags, so a run reaches the rule under test */
const GEN_REQUIRED = ["--out", "o", "--target", "ts"]

/** What a parse of `argv` gave: its error's message with the value flag's name as `<V>`, else the value it read. */
function outcome(parse: () => unknown, valueFlag: string, read: (flags: never) => unknown): unknown {
	try {
		return read(parse() as never)
	} catch (err) {
		return (err as Error).message.replaceAll(`--${valueFlag}`, "--<V>")
	}
}

/** One rule's argv, `<V>` its value flag, through core (as --app) and gen (as --spec). */
function both(argv: string[]) {
	const as = (flag: string) => argv.map((arg) => arg.replace("<V>", flag))
	return {
		core: outcome(
			() => parseGenerateArgs(as("app")),
			"app",
			(flags: { app?: string; watch?: boolean }) => [
				flags.app,
				/* an unset flag is absent in core, gen's run defaults it */
				flags.watch ?? false,
			],
		),
		gen: outcome(
			() => parseGenerate([...as("spec"), ...GEN_REQUIRED]),
			"spec",
			(run: { spec: string; watch: boolean }) => [run.spec, run.watch],
		),
	}
}

describe("honey and honey-clients read their arguments by the same rules (bit 19 h1)", () => {
	it.each([
		["a value after the flag", ["--<V>", "a.ts"]],
		["a value inline, an = inside it kept", ["--<V>=a=b.ts"]],
		["a value flag before another flag", ["--<V>", "--watch"]],
		["a value flag last", ["--watch", "--<V>"]],
		["an empty inline value", ["--<V>="]],
		["a bare boolean", ["--<V>", "a.ts", "--watch"]],
		["a boolean set false", ["--<V>", "a.ts", "--watch=false"]],
		["a boolean given another value", ["--<V>", "a.ts", "--watch=yes"]],
		["an unknown flag", ["--nope"]],
		["a stray argument", ["a.ts"]],
		["a bare --", ["--"]],
	])("%s", (_rule, argv) => {
		const { core, gen } = both(argv)
		expect(core).toEqual(gen)
	})
})
