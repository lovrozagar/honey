import { describe, expect, it } from "vitest"
import { MIRROR, mirrorNotice } from "./mirror.ts"

describe("the safe mirror's name against a root group (bit 21 i)", () => {
	it("names the rename of a root group spelled like the mirror, in the language's own spelling", () => {
		expect([MIRROR, mirrorNotice("ts", "safe", "safe", "safe_"), mirrorNotice("go", "Safe", "Safe", "Safe_")]).toEqual([
			"safe",
			'ts: the root group "safe" is emitted as "safe_": "safe" is the client\'s safe mirror',
			'go: the root group "Safe" is emitted as "Safe_": "Safe" is the client\'s safe mirror',
		])
	})

	it("says nothing for a group spelled otherwise", () => {
		expect([mirrorNotice("ts", "safe", "users", "users"), mirrorNotice("ts", "safe", "Safe", "Safe")]).toEqual([
			null,
			null,
		])
	})
})
