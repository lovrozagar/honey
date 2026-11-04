/**
 * A Go module's path (plan 39 8.5): the SDK and the CLI refuse a path Go would not publish, the CLI's grammar now the
 * SDK's too, and a `version` option puts its major suffix (`/vN`, from v2) on the path, as Go requires a v2+ module
 * to declare it. Each verdict on a domain path is checked against the pinned Go's own `go mod init`.
 */
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { builtCli, STAMPED } from "../cli/__fixtures__/built.ts"
import { generateGoCli } from "../cli/module.ts"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"
import { goCacheDir, runGo, withGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"

/* a cold module cache fetches cobra first */
const SLOW = { timeout: 600_000 }

const DOC = { info: { title: "Shop", version: "1" }, openapi: "3.1.0", paths: {} }

/** The module path go.mod declares. */
const moduleOf = (files: Readonly<Record<string, string>>) => /^module (\S+)$/m.exec(files["go.mod"] ?? "")?.[1]

/* the paths Go reads as a major version suffix, each a verdict apart, and the paths before and after them; a
 * dotless path (`shop`) is left out: go mod init takes it as a local module, which no proxy serves, and the SDK and
 * the CLI refuse it as the first test shows */
const PATHS = [
	"example.com/shop",
	"example.com/shop/v2",
	"example.com/shop/v10",
	"example.com/v2",
	"example.com/shop/v2/sdk",
	"example.com/shop/V2",
	"example.com/shop/v1",
	"example.com/shop/v0",
	"example.com/shop/v02",
	"example.com/shop/v2.1",
	"example.com/a b",
] as const

/** Whether generateGoSdk takes `modulePath`. */
const takes = (modulePath: string) => {
	try {
		return moduleOf(generateGoSdk(DOC, { modulePath }).files) === modulePath
	} catch {
		return false
	}
}

describe("the Go module path the SDK and the CLI take (plan 39 8.5)", () => {
	it("is refused by the SDK as by the CLI, naming it", () => {
		for (const modulePath of ["example.com/shop/v1", "example.com/shop/v2.1", "shop"])
			for (const generate of [() => generateGoSdk(DOC, { modulePath }), () => generateGoCli(DOC, { modulePath })])
				expect(generate).toThrow(`Invalid modulePath: ${JSON.stringify(modulePath)}`)
	})

	it.skipIf(!withGo())(
		"is refused exactly where the pinned Go's go mod init refuses it",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const inits = PATHS.map((path) => {
				const dir = mkdtempSync(join(goCacheDir("tmp"), "mod-init-"))
				return runGo(["mod", "init", path], { cwd: dir }).status === 0
			})
			expect(PATHS.map(takes)).toEqual(inits)
		},
	)
})

describe("the major suffix a version puts on the module path (plan 39 8.5)", () => {
	it("appends /vN from v2 on, in the SDK's go.mod and every path the CLI builds from", () => {
		const sdk = (version: string) => moduleOf(generateGoSdk(DOC, { modulePath: "example.com/shop", version }).files)
		const cli = generateGoCli(DOC, { modulePath: "example.com/shop", version: "2.1.0" }).files
		expect({
			cli: [
				moduleOf(cli),
				cli["main.go"]?.includes('"example.com/shop/v2/internal/cli"'),
				cli[".goreleaser.yaml"]?.includes("-X example.com/shop/v2/internal/cli.Version={{ .Tag }}"),
			],
			sdk: [sdk("0.3.0"), sdk("1.4.0"), sdk("2.1.0"), sdk("12.0.0-rc.1")],
		}).toEqual({
			cli: ["example.com/shop/v2", true, true],
			sdk: ["example.com/shop", "example.com/shop", "example.com/shop/v2", "example.com/shop/v12"],
		})
	})

	it("refuses a version that is not semver, and a path that already carries a suffix the version would give", () => {
		expect(() => generateGoSdk(DOC, { modulePath: "example.com/shop", version: "v2" })).toThrow('Invalid version: "v2"')
		expect(() => generateGoCli(DOC, { modulePath: "example.com/shop/v2", version: "2.1.0" })).toThrow(
			'Invalid modulePath: "example.com/shop/v2"',
		)
	})
})

describe.skipIf(!withGo())("a v2 CLI, built (plan 39 8.5)", SLOW, () => {
	it("builds from its suffixed module, the version stamped through the suffixed package path", async () => {
		const { built, cli, linkErrors } = builtCli(
			generateGoCli(DOC, { binaryName: "shop", modulePath: "example.com/shop", version: "2.1.0" }).files,
		)
		const version = await cli(["--version"])
		expect([built, linkErrors, version.status, version.stdout]).toEqual([true, "", 0, `${STAMPED}\n`])
	})
})
