import { describe, expect, it } from "vitest"
import { parseUserAgent } from "./user-agent.ts"

const UNKNOWN = { browser: null, browserMajor: null, deviceType: "unknown", os: null, osVersion: null }

const CHROME = "Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0.0.0 Safari/537.36"

const REAL_HEADERS = [
	[
		"Chrome on Windows",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
		{
			browser: "Chrome",
			browserMajor: 141,
			deviceType: "desktop",
			os: "Windows",
			osVersion: "10",
		},
	],
	[
		"Edge on Windows",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.71",
		{ browser: "Edge", browserMajor: 141, deviceType: "desktop", os: "Windows", osVersion: "10" },
	],
	[
		"Firefox on Linux",
		"Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
		{
			browser: "Firefox",
			browserMajor: 143,
			deviceType: "desktop",
			os: "Linux",
			osVersion: null,
		},
	],
	[
		"Safari on macOS",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
		{
			browser: "Safari",
			browserMajor: 26,
			deviceType: "desktop",
			os: "macOS",
			osVersion: "10.15.7",
		},
	],
	[
		"Safari on iPhone",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
		{ browser: "Safari", browserMajor: 18, deviceType: "mobile", os: "iOS", osVersion: "18.6" },
	],
	[
		"Chrome on iPad",
		"Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1",
		{
			browser: "Chrome",
			browserMajor: 141,
			deviceType: "tablet",
			os: "iPadOS",
			osVersion: "18.6",
		},
	],
	[
		"Samsung Internet on Android",
		"Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
		{
			browser: "Samsung Internet",
			browserMajor: 28,
			deviceType: "mobile",
			os: "Android",
			osVersion: "15",
		},
	],
	[
		"Chrome on an Android tablet",
		"Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
		{
			browser: "Chrome",
			browserMajor: 141,
			deviceType: "tablet",
			os: "Android",
			osVersion: "14",
		},
	],
	[
		"Opera on Windows",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0",
		{
			browser: "Opera",
			browserMajor: 124,
			deviceType: "desktop",
			os: "Windows",
			osVersion: "10",
		},
	],
	[
		"Firefox on iOS",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15",
		{ browser: "Firefox", browserMajor: 143, deviceType: "mobile", os: "iOS", osVersion: "18.6" },
	],
	[
		"Chrome on ChromeOS",
		"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
		{
			browser: "Chrome",
			browserMajor: 141,
			deviceType: "desktop",
			os: "ChromeOS",
			osVersion: null,
		},
	],
	[
		"Googlebot",
		"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
		{ browser: null, browserMajor: null, deviceType: "bot", os: null, osVersion: null },
	],
	["curl", "curl/8.9.1", { browser: null, browserMajor: null, deviceType: "bot", os: null, osVersion: null }],
] as const

describe("parseUserAgent: real headers", () => {
	it.each(REAL_HEADERS)("%s", (_label, ua, expected) => {
		expect(parseUserAgent(ua)).toEqual(expected)
	})
})

describe("parseUserAgent: what a client controls", () => {
	it.each([[null], [undefined], [""], ["%%%"]])("%j is unknown", (ua) => {
		expect(parseUserAgent(ua)).toEqual(UNKNOWN)
	})

	it("reads a token ending inside the first 512 characters", () => {
		const ua = `${"x".repeat(511 - "Chrome/141".length)} Chrome/141`
		expect(parseUserAgent(ua).browserMajor).toBe(141)
	})

	it("ignores a token past the first 512 characters", () => {
		expect(parseUserAgent(`${"x".repeat(511)} Chrome/141`).browser).toBeNull()
	})

	it("keeps the browser and drops a version past the safe range", () => {
		const huge = { browser: "Chrome", browserMajor: null }
		expect(parseUserAgent(`Chrome/${"9".repeat(400)}`)).toMatchObject(huge)
		expect(parseUserAgent("Chrome/90071992547409931")).toMatchObject(huge)
	})

	it("needs both Version and Safari to call a browser Safari", () => {
		expect(parseUserAgent("Version/18.6").browser).toBeNull()
		expect(parseUserAgent("Safari/605.1.15").browser).toBeNull()
		expect(parseUserAgent("Version/18.6 Mobile/15E148 Safari/604.1")).toMatchObject({
			browser: "Safari",
			browserMajor: 18,
		})
	})

	it("reads an iPad sending a Mac header as the Mac it claims to be", () => {
		const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15"
		expect(parseUserAgent(ua)).toMatchObject({ deviceType: "desktop", os: "macOS" })
	})

	it("takes an iOS version only after the device token", () => {
		expect(parseUserAgent("OS 18_6 like iPad").os).toBeNull()
	})

	it("answers a fresh object, so a caller's edit reaches no other", () => {
		expect(parseUserAgent(CHROME)).not.toBe(parseUserAgent(CHROME))
	})
})

describe("parseUserAgent: Windows versions", () => {
	it.each([
		["6.1", "7"],
		["6.2", "8"],
		["6.3", "8.1"],
		["5.1", "5.1"],
	])("NT %s is %s", (nt, osVersion) => {
		expect(parseUserAgent(`Mozilla/5.0 (Windows NT ${nt})`).osVersion).toBe(osVersion)
	})
})
