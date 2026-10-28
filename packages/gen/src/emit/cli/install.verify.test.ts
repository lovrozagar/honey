/**
 * The install scripts' signature check (bit 19 i, carry-in #3), run against a local fake release with a fake cosign
 * on PATH:
 * - with cosign, checksums.txt's bundle is checked as the repository's release workflow on a v* tag (the identity
 *   and the OIDC issuer pinned in its arguments) before the sha256 check; a forged or missing bundle refuses, one
 *   line, nothing installed;
 * - without cosign the sha256 check alone installs, as before (zero setup);
 * - `<PREFIX>_INSTALL_VERIFY=require` refuses, before any fetch, without cosign or without a repository naming the
 *   signer; any other value refuses;
 * install.ps1's legs are install-ps1.test.ts's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	BASE_TOOLS,
	BUNDLE,
	CALL,
	cosignCalls,
	FORGED,
	inTurn,
	LINUX,
	NO_COSIGN,
	NO_REPO,
	outcome,
	release,
	runSh,
	type Served,
	scripts,
	serve,
	tarGz,
	UNKNOWN,
	withCosign,
} from "./__fixtures__/install.ts"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"
const SH_TOOLS = [...BASE_TOOLS, "uname", "curl"]

let server: Served
beforeAll(async () => {
	server = await serve()
})
afterAll(() => server.close())

describe("install.sh checks checksums.txt's signature when cosign is on PATH (bit 19 i)", () => {
	it(
		"installs once the bundle verifies as the repository's release workflow, the identity and issuer pinned",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			server.set(release({ [LINUX]: tarGz() }, { bundle: "valid" }))
			const { log, path } = withCosign(SH_TOOLS)
			const run = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url }, path)
			expect([outcome(run), server.asked, cosignCalls(log)]).toEqual([
				[0, true, ""],
				[LINUX, "checksums.txt", BUNDLE],
				CALL,
			])
		},
	)

	it(
		"refuses a forged bundle and a missing one, one line each, nothing installed and no temp dir left",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const archive = tarGz()
			const { path } = withCosign(SH_TOOLS)
			server.set(release({ [LINUX]: archive }, { bundle: "forged" }))
			const forged = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url }, path)
			server.set(release({ [LINUX]: archive }))
			const missing = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url }, path)
			expect([forged, missing].map((run) => [...outcome(run), run.left])).toEqual([
				[1, false, FORGED, []],
				/* curl's own line first (-S), as for any download that fails */
				[
					1,
					false,
					`curl: (22) The requested URL returned error: 404\nshop install: could not download ${server.url}/${BUNDLE}\n`,
					[],
				],
			])
		},
	)

	it(
		"installs by the sha256 check alone without cosign, or without a repository to name the signer",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			server.set(release({ [LINUX]: tarGz() }))
			const bare = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url })
			const { log, path } = withCosign(SH_TOOLS)
			const unnamed = await runSh(scripts(null).sh, { SHOP_INSTALL_BASE: server.url }, path)
			expect([outcome(bare), outcome(unnamed), server.asked, cosignCalls(log)]).toEqual([
				[0, true, ""],
				[0, true, ""],
				[LINUX, "checksums.txt", LINUX, "checksums.txt"],
				"",
			])
		},
	)
})

describe("install.sh's SHOP_INSTALL_VERIFY (bit 19 i)", () => {
	it(
		"refuses before any fetch when require cannot be met, or the value is not require",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			server.set(release({ [LINUX]: tarGz() }, { bundle: "valid" }))
			const base = { SHOP_INSTALL_BASE: server.url }
			const { path } = withCosign(SH_TOOLS)
			const runs = await inTurn([
				() => runSh(scripts().sh, { ...base, SHOP_INSTALL_VERIFY: "require" }),
				() => runSh(scripts(null).sh, { ...base, SHOP_INSTALL_VERIFY: "require" }, path),
				() => runSh(scripts().sh, { ...base, SHOP_INSTALL_VERIFY: "yes" }, path),
			])
			expect([runs.map(outcome), server.asked]).toEqual([
				[
					[1, false, NO_COSIGN],
					[1, false, NO_REPO],
					[1, false, UNKNOWN],
				],
				[],
			])
		},
	)

	it("installs under require once cosign verifies the bundle", { timeout: SPAWN_TIMEOUT }, async () => {
		server.set(release({ [LINUX]: tarGz() }, { bundle: "valid" }))
		const { log, path } = withCosign(SH_TOOLS)
		const run = await runSh(scripts().sh, { SHOP_INSTALL_BASE: server.url, SHOP_INSTALL_VERIFY: "require" }, path)
		expect([outcome(run), cosignCalls(log)]).toEqual([[0, true, ""], CALL])
	})
})
