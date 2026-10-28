/**
 * The v0 case inventory (H13): every case the frozen v0 suite held, named `describe > … > name`, with a stable
 * id and the feature (= the bit that owns it) it exercises, committed in blueprint/baselines/v0-cases.json. Each
 * bit ported or retired its features' cases, tagged `// v0: <id>` in the v1 test, and reorg-coverage-diff holds
 * every completed feature to that. The parser that read `_v0/tests` into the inventory went with `_v0` (bit 20 e;
 * v0 at 1a968f1), so the inventory is frozen: it changes only by a retirement or a reassignment.
 */

export type V0Case = { feature: Feature; file: string; id: string; name: string }

/** A bit owner's correction: the feature that really owns a case, and why. */
export type Reassignment = { feature: Feature; reason: string }

export const FEATURES = [
	"01-core-route-model",
	"02-finalize-middleware",
	"03-request-trust-adapters",
	"04-adapters",
	"05-streaming-sse-range",
	"06-realtime",
	"07-security-middleware",
	"08-io",
	"09-ir-seam",
	"10-openapi-emit",
	"11-ts-client",
	"12-go-sdk",
	"13-rust-sdk",
	"14-python-sdk",
	"17-cli-gold-standard",
	"18-mcp",
	"19-release-provenance",
	"20-docs",
] as const
export type Feature = (typeof FEATURES)[number]

type Accounting = {
	complete: number
	ported: ReadonlySet<string>
	/** id → the feature a bit owner moved a misfiled case to */
	reassigned?: Readonly<Record<string, Reassignment>>
	retired: Readonly<Record<string, string>>
}

/** The cases of every feature whose bit has completed that no v1 test ports and no reason retires. */
export function unaccounted(
	cases: readonly V0Case[],
	{ complete, ported, reassigned = {}, retired }: Accounting,
): string[] {
	return cases
		.map((c) => ({ ...c, feature: reassigned[c.id]?.feature ?? c.feature }))
		.filter((c) => Number(c.feature.slice(0, 2)) <= complete && !ported.has(c.id) && retired[c.id] === undefined)
		.map((c) => `${c.feature} ${c.id} ${c.name}`)
}
