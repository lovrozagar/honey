/**
 * install.ps1 (bit 17 phase g; split from install.test.ts at bit 19 i), run under the pinned PowerShell against a
 * local server holding a fake release, as install.sh's legs run:
 * - it parses, installs this architecture's zip once its sha256 matches checksums.txt, and refuses a tampered
 *   archive, a base neither https:// nor http:// on loopback, and an unknown architecture;
 * - a truncated download runs nothing;
 * - bit 19 i: with a fake cosign on PATH, a verified bundle installs and a forged one refuses with the identity and
 *   issuer pinned; without cosign the sha256 check alone installs; SHOP_INSTALL_VERIFY refuses as install.sh's does.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	BUNDLE,
	CALL,
	cosignCalls,
	FORGED,
	inTurn,
	NO_COSIGN,
	NO_REPO,
	outcome,
	release,
	runPs1,
	type Served,
	scratch,
	scripts,
	serve,
	sha256,
	UNKNOWN,
	WINDOWS,
	withCosign,
	ZEROS,
	zipOf,
} from "./__fixtures__/install.ts"
import { syntaxCheck, withTools } from "./__fixtures__/tools.ts"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"

const TOOLS = withTools()

let server: Served
beforeAll(async () => {
	server = await serve()
})
afterAll(() => server.close())

describe.skipIf(!TOOLS)("install.ps1 under PowerShell (phase g)", () => {
	it(
		"parses, installs this architecture's zip once its sha256 matches, and refuses as install.sh does",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const zip = zipOf()
			server.set(release({ [WINDOWS]: zip, "shop_windows_arm64.zip": zip }))
			const file = join(scratch("parse"), "install.ps1")
			writeFileSync(file, scripts().ps1)
			const parsed = syntaxCheck("powershell", file)
			const arches: Record<string, string>[] = [{}, { SHOP_INSTALL_ARCH: "arm64" }, { SHOP_INSTALL_ARCH: "mips" }]
			const runs = await inTurn(
				arches.map((env) => () => runPs1(scripts().ps1, { SHOP_INSTALL_BASE: server.url, ...env })),
			)
			server.set(release({ [WINDOWS]: zip }, { tampered: WINDOWS }))
			const refused = await inTurn(
				[server.url, "http://example.com"].map((base) => () => runPs1(scripts().ps1, { SHOP_INSTALL_BASE: base })),
			)
			expect({ parsed, refused: refused.map(outcome), runs: runs.map(outcome) }).toEqual({
				parsed: { errors: "", status: 0 },
				refused: [
					[1, false, `shop install: ${WINDOWS}: its sha256 is ${sha256(zip)}, checksums.txt says ${ZEROS}\n`],
					[1, false, "shop install: http://example.com: want https://, or http:// on loopback\n"],
				],
				runs: [
					[0, true, ""],
					[0, true, ""],
					[1, false, "shop install: SHOP_INSTALL_ARCH mips: want amd64 or arm64\n"],
				],
			})
		},
	)

	it("runs nothing when the download stops short of its last line", { timeout: SPAWN_TIMEOUT }, async () => {
		server.set(release({ [WINDOWS]: zipOf() }))
		const text = scripts().ps1
		const cut = await runPs1(text.slice(0, text.lastIndexOf("Install-Release\n")), { SHOP_INSTALL_BASE: server.url })
		expect([cut.ran.status, cut.installed, server.asked]).toEqual([0, false, []])
	})
})

describe.skipIf(!TOOLS)("install.ps1's signature check under PowerShell (bit 19 i)", () => {
	const PS1_TOOLS = ["sh", "cat", "sha256sum", "awk"]

	it(
		"installs on a verified bundle and refuses a forged one, with the identity and issuer pinned",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const zip = zipOf()
			const { log, path } = withCosign(PS1_TOOLS)
			server.set(release({ [WINDOWS]: zip }, { bundle: "valid" }))
			const good = await runPs1(scripts().ps1, { SHOP_INSTALL_BASE: server.url }, path)
			const asked = [...server.asked]
			server.set(release({ [WINDOWS]: zip }, { bundle: "forged" }))
			const forged = await runPs1(scripts().ps1, { SHOP_INSTALL_BASE: server.url }, path)
			expect([outcome(good), asked, outcome(forged), cosignCalls(log)]).toEqual([
				[0, true, ""],
				[WINDOWS, "checksums.txt", BUNDLE],
				[1, false, FORGED],
				`${CALL}${CALL}`,
			])
		},
	)

	it(
		"installs by the sha256 check alone without cosign, and refuses as install.sh does under SHOP_INSTALL_VERIFY",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			server.set(release({ [WINDOWS]: zipOf() }, { bundle: "valid" }))
			const base = { SHOP_INSTALL_BASE: server.url }
			const { path } = withCosign(PS1_TOOLS)
			const refused = await inTurn([
				() => runPs1(scripts().ps1, { ...base, SHOP_INSTALL_VERIFY: "require" }),
				() => runPs1(scripts(null).ps1, { ...base, SHOP_INSTALL_VERIFY: "require" }, path),
				() => runPs1(scripts().ps1, { ...base, SHOP_INSTALL_VERIFY: "yes" }, path),
			])
			const asked = [...server.asked]
			const bare = await runPs1(scripts().ps1, base)
			expect([refused.map(outcome), asked, outcome(bare), server.asked]).toEqual([
				[
					[1, false, NO_COSIGN],
					[1, false, NO_REPO],
					[1, false, UNKNOWN],
				],
				[],
				[0, true, ""],
				[WINDOWS, "checksums.txt"],
			])
		},
	)
})
