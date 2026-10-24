/**
 * The agent skill (bit 17 phase e, E1): SKILL.md's frontmatter is valid Agent Skills (a name the binary's, of at most
 * 64 lowercase letters, digits and `-`; a one-line description within 1024 characters, a YAML scalar whatever the
 * title holds); the binary's `skill` prints the shipped file byte for byte; every command it names exists; its
 * streams section is there only for an API with streams.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { sdkModel } from "../../ir/sdk-model.ts"
import { toIR, type OpenApiDocument } from "../../ir/build.ts"
import { withGo } from "../go/__fixtures__/go-env.ts"
import { builtCli } from "./__fixtures__/built.ts"
import { catalog, HOSTILE } from "./__fixtures__/catalog.ts"
import { hasControl } from "./__fixtures__/controls.ts"
import { shop } from "./__fixtures__/shop.ts"
import { yamlValue } from "./__fixtures__/yaml.ts"
import { generateGoCli } from "./module.ts"
import { skillFile, skillPath } from "./skills.ts"

const GO = withGo()
const SLOW = { timeout: 600_000 }

const built = () => builtCli(generateGoCli(shop()).files)

/** SKILL.md's frontmatter, as YAML reads it. */
const frontmatter = (skill: string) =>
	yamlValue(/^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "") as Record<string, string>

/** The skill an API's document gives under `bin`. */
const skillOf = (doc: Record<string, unknown>, bin: string) => {
	const ir = toIR(doc as OpenApiDocument, { deriveOperationIds: true })
	return skillFile(bin, ir.info.title ?? bin, bin.toUpperCase(), sdkModel(ir).ops)
}

describe("SKILL.md (phase e)", () => {
	it("has the frontmatter Agent Skills reads: the binary's name and a one-line description", () => {
		const meta = frontmatter(generateGoCli(shop()).files[skillPath("shop")] ?? "")
		expect([Object.keys(meta), meta.name, meta.description]).toEqual([
			["name", "description"],
			"shop",
			"Call the Shop API from the shell with shop: find a command, read its request and answer, call it, and branch on its JSON output and exit code.",
		])
	})

	it("keeps a hostile or long title one YAML scalar within 1024 characters, no control character in it", () => {
		const long = frontmatter(
			skillOf({ ...catalog(), info: { title: `${"Very ".repeat(300)}API`, version: "1" } }, "catalog"),
		)
		const hostile = frontmatter(
			skillOf({ ...catalog(), info: { title: `A: "b" ${HOSTILE}\n# c`, version: "1" } }, "catalog"),
		)
		expect({
			controls: hasControl(hostile.description ?? ""),
			hostile: hostile.description?.startsWith('Call the A: "b" [2J # c API'),
			long: (long.description?.length ?? 0) <= 1024,
			names: [long.name, hostile.name],
		}).toEqual({ controls: false, hostile: true, long: true, names: ["catalog", "catalog"] })
	})

	it("names an untitled API by its binary, and an SSE-only one's streams without the ws or realtime lines", () => {
		const sse = { ...shop(), paths: { "/ticks": (shop().paths as Record<string, unknown>)["/ticks"] } }
		const [untitled, onlySse] = [
			skillOf({ ...catalog(), info: { title: " \n ", version: "1" } }, "catalog"),
			skillOf(sse, "shop"),
		]
		expect([
			frontmatter(untitled).description?.startsWith("Call the catalog API"),
			onlySse.split("## Streams\n")[1]?.split("\n\n")[0],
		]).toEqual([true, "A stream command (sse) prints one JSON line per event; `--take N` ends it after N."])
	})

	it("has its streams section only for an API with streams, naming the kinds it has", () => {
		const [streams, none] = [skillOf(shop(), "shop"), skillOf(catalog(), "catalog")]
		expect([/^## Streams$/m.test(none), streams.split("## Streams\n")[1]?.split("\n")[0]]).toEqual([
			false,
			"A stream command (sse, ws, realtime) prints one JSON line per event; `--take N` ends it after N.",
		])
	})
})

describe.skipIf(!GO)("the shipped skill (phase e)", SLOW, () => {
	beforeAll(() => void built(), SLOW.timeout)

	it("prints the module's SKILL.md byte for byte from `shop skill`", async () => {
		const ran = await built().cli(["skill"], {})
		expect([ran.status, ran.stdout]).toEqual([0, generateGoCli(shop()).files[skillPath("shop")]])
	})

	it("names only commands the binary has", async () => {
		const skill = generateGoCli(shop()).files[skillPath("shop")] ?? ""
		const named = [...new Set([...skill.matchAll(/`shop ([a-z][a-z -]*?)(?: <[^`]*)?`/g)].map((m) => m[1] as string))]
		const statuses: [string, number][] = []
		for (const command of named)
			statuses.push([command, (await built().cli([...command.split(" "), "--help"], {})).status])
		expect([named, statuses.filter(([, status]) => status !== 0)]).toEqual([
			["commands", "commands search", "schema", "config"],
			[],
		])
	})
})
