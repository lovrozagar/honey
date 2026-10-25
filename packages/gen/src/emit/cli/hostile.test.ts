/**
 * A hostile document, built (bit 17 phase i, F2): every spec string that reaches the CLI's Go source does so as an
 * escaped literal, so a title, summary or description carrying quotes, backticks, a comment's end, `$(…)`, a format
 * verb and a newline compiles, and the binary prints it as the document wrote it, its controls dropped: the root help,
 * the index line, the command's help, the skill. The install scripts carry none of it: they take validated options only.
 */
import { describe, expect, it } from "vitest"
import { withGo } from "../go/__fixtures__/go-env.ts"
import { builtCli } from "./__fixtures__/built.ts"
import { hasControl } from "./__fixtures__/controls.ts"
import { summaryOf } from "./discovery.ts"
import { helpText } from "./flags.ts"
import { generateGoCli } from "./module.ts"

const GO = withGo()
const SLOW = { timeout: 600_000 }

/** The printable hostile text: what a Go string, a shell, a format string or a comment would each misread. */
const PRINTABLE = `Say "hi" 'x' \`y\` */ /* $(id) \${HOME} %s %d 100% \\ done`
/** Controls the help drops: NUL, BEL, an escape sequence, a carriage return, DEL, C1 NEL, U+2028 and the BOM. */
const CONTROLS = "\u0000\u0007\u001b[2J\r\u007f\u0085\u2028\ufeff\u202e\u2066\u200f\u061c"

const TITLE = `Shop ${PRINTABLE}${CONTROLS}\nsecond line`
/** A string default with quotes, format verbs, a backslash and the controls. */
const DEFAULT = `say "hi" %d %s \\ ${CONTROLS}end`
const SUMMARY = `Greet ${PRINTABLE}${CONTROLS}`
const DESCRIPTION = `First ${PRINTABLE}\n${CONTROLS}Second line`

const document = () => ({
	info: { description: DESCRIPTION, title: TITLE, version: "1" },
	openapi: "3.1.0",
	paths: {
		"/greet": {
			get: {
				description: DESCRIPTION,
				operationId: "greet.get",
				parameters: [
					{ in: "query", name: "tone", schema: { enum: ['50%"off', "-created_at", "%d"], type: "string" } },
					{ in: "query", name: "note", schema: { default: DEFAULT, type: "string" } },
				],
				responses: { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
				summary: SUMMARY,
			},
		},
	},
})

describe.skipIf(!GO)("a hostile document, built (phase i, F2)", SLOW, () => {
	const generated = generateGoCli(document(), { binaryName: "shop", repo: "acme/shop" })
	const shop = builtCli(generated.files)

	// v0: d1636bf8d0
	it("compiles and vets", () => {
		expect({ built: shop.built, link: shop.linkErrors, vet: shop.vet }).toEqual({ built: true, link: "", vet: [] })
	})

	it("prints the title in the root help as the document wrote it, a format verb literal, no control", async () => {
		const help = (await shop.cli(["--help"])).stdout
		expect([help.startsWith(`${helpText(TITLE)}\n\nAgents: `), hasControl(help)]).toEqual([true, false])
	})

	it("prints the summary in the index and its group's command list, the description in the command's help", async () => {
		const [index, group, command] = await Promise.all(
			[["commands"], ["greet", "--help"], ["greet", "get", "--help"]].map(
				async (args) => (await shop.cli(args)).stdout,
			),
		)
		expect([
			index.split("\n").find((line) => line.startsWith("greet get")),
			group.includes(`Greet ${PRINTABLE}`),
			command.startsWith(`${helpText(DESCRIPTION)}\n`),
			[index, group, command].some(hasControl),
		]).toEqual([
			`greet get [--note string] [--tone "50%\\"off"|-created_at|"%d"] # ${summaryOf(SUMMARY)}`,
			true,
			true,
			false,
		])
	})

	it("names the API in the skill on one line, no control", async () => {
		const skill = (await shop.cli(["skill"])).stdout
		const description = skill.split("\n").find((line) => line.startsWith("description: ")) ?? ""
		expect([
			(JSON.parse(description.slice("description: ".length)) as string).includes(
				helpText(TITLE).replace(/\s+/g, " ").trim(),
			),
			hasControl(skill),
		]).toEqual([true, false])
	})

	it("writes none of the document into the install scripts", () => {
		const scripts = `${generated.files["install.sh"]}${generated.files["install.ps1"]}`
		expect(["$(id)", "${HOME}", "Greet", "Say ", "second line"].filter((text) => scripts.includes(text))).toEqual([])
	})
})

/** The hostile document's CLI, built (cached by its content, as the describe above builds it). */
const built = () => builtCli(generateGoCli(document(), { binaryName: "shop", repo: "acme/shop" }).files)

describe.skipIf(!GO)("a hostile document's flags, built (phase i, F2)", SLOW, () => {
	// v0: 165597d9a3
	// v0: d576203419
	it("refuses a value outside an enum naming the values literally, a quote and format verbs as written", async () => {
		const ran = await built().cli(["greet", "get", "--tone", "x"])
		expect([ran.status, (JSON.parse(ran.stderr) as { error: { message: string } }).error.message]).toEqual([
			4,
			'invalid argument "x" for "--tone" flag: must be one of 50%"off, -created_at, %d',
		])
	})

	it("shows a hostile string default in the flag's help quoted as written, its controls dropped", async () => {
		const help = (await built().cli(["greet", "get", "--help"])).stdout
		const note = help.split("\n").find((line) => line.trimStart().startsWith("--note"))
		expect([note?.trimEnd().endsWith(`(default ${JSON.stringify(helpText(DEFAULT))})`), hasControl(help)]).toEqual([
			true,
			false,
		])
	})
})
