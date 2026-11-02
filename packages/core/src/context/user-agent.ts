/**
 * A coarse read of a `User-Agent` header, for session lists and new-device checks. It names a
 * browser and an OS family and nothing finer: no device models and no engine versions.
 *
 * The header is whatever the client sent, so nothing here is proof of identity. Only the first 512
 * characters are read, and every pattern runs in time linear to those.
 *
 * Safari on an iPad sends a Mac header by default, so it reads as macOS desktop. The header alone
 * cannot tell the two apart.
 */

/** The coarse family a client belongs to, `"unknown"` when its header names none of them. */
export type DeviceType = "bot" | "desktop" | "mobile" | "tablet" | "unknown"

/** What {@link parseUserAgent} could read from a header. */
export type ParsedUserAgent = {
	/** The browser's name, or `null` when none matched and for a bot. */
	browser: string | null
	/** The browser's major version, or `null` when it is missing or past the safe integer range. */
	browserMajor: number | null
	/** The client's coarse family. */
	deviceType: DeviceType
	/** The OS family, or `null` when none matched and for a bot. */
	os: string | null
	/** The OS version as dotted text, or `null` when the header carries none. */
	osVersion: string | null
}

type Os = Pick<ParsedUserAgent, "deviceType" | "os" | "osVersion">

/* real headers stay well under this, so anything longer is not worth scanning */
const MAX_LENGTH = 512

const BOT = /bot\b|crawl|spider|slurp|headless|^curl\/|^wget\/|python-requests|okhttp|httpclient/i

/* order matters: Edge, Opera and Samsung Internet also claim Chrome, and Chrome claims Safari */
const BROWSERS: ReadonlyArray<{ name: string; pattern: RegExp; needs?: RegExp }> = [
	{ name: "Edge", pattern: /\b(?:Edg|EdgA|EdgiOS)\/(\d+)/ },
	{ name: "Opera", pattern: /\b(?:OPR|OPiOS)\/(\d+)/ },
	{ name: "Samsung Internet", pattern: /\bSamsungBrowser\/(\d+)/ },
	{ name: "Firefox", pattern: /\b(?:Firefox|FxiOS)\/(\d+)/ },
	{ name: "Chrome", pattern: /\b(?:CriOS|Chrome)\/(\d+)/ },
	/* two patterns, because one spanning both tokens is cubic on `Version/` and digits */
	{ name: "Safari", needs: /\bSafari\//, pattern: /\bVersion\/(\d+)/ },
]

/* Windows 11 still reports NT 10.0 */
const WINDOWS_VERSIONS: Readonly<Record<string, string>> = {
	"6.1": "7",
	"6.2": "8",
	"6.3": "8.1",
	"10.0": "10",
}

const OS_TOKEN = /\bOS (\d+(?:_\d+)*)/

const dotted = (version: string | undefined) => version?.replaceAll("_", ".") ?? null

/* two steps, because one pattern with `.*?` between the tokens rescans from every device token */
const iosVersion = (ua: string, device: RegExp) => {
	const at = ua.search(device)
	return at === -1 ? undefined : OS_TOKEN.exec(ua.slice(at))?.[1]
}

const readOs = (ua: string): Os => {
	const ipad = iosVersion(ua, /\biPad\b/)
	if (ipad !== undefined) return { deviceType: "tablet", os: "iPadOS", osVersion: dotted(ipad) }

	const iphone = iosVersion(ua, /\b(?:iPhone|iPod)\b/)
	if (iphone !== undefined) return { deviceType: "mobile", os: "iOS", osVersion: dotted(iphone) }

	const android = /\bAndroid (\d+(?:\.\d+)*)/.exec(ua)?.[1]
	if (android !== undefined) {
		return { deviceType: /\bMobile\b/.test(ua) ? "mobile" : "tablet", os: "Android", osVersion: android }
	}

	const windows = /\bWindows NT (\d+\.\d+)/.exec(ua)?.[1]
	if (windows !== undefined) {
		return { deviceType: "desktop", os: "Windows", osVersion: WINDOWS_VERSIONS[windows] ?? windows }
	}

	const mac = /\bMac OS X (\d+(?:[_.]\d+)*)/.exec(ua)?.[1]
	if (mac !== undefined) return { deviceType: "desktop", os: "macOS", osVersion: dotted(mac) }

	if (/\bCrOS\b/.test(ua)) return { deviceType: "desktop", os: "ChromeOS", osVersion: null }
	if (/\bLinux\b/.test(ua)) return { deviceType: "desktop", os: "Linux", osVersion: null }

	return { deviceType: "unknown", os: null, osVersion: null }
}

const readBrowser = (ua: string): Pick<ParsedUserAgent, "browser" | "browserMajor"> => {
	for (const { name, needs, pattern } of BROWSERS) {
		const match = pattern.exec(ua)
		if (match === null || needs?.test(ua) === false) continue
		const major = Number(match[1])
		return { browser: name, browserMajor: Number.isSafeInteger(major) ? major : null }
	}
	return { browser: null, browserMajor: null }
}

/**
 * Reads a `User-Agent` header into a coarse browser, OS and device. A missing or unreadable header
 * answers nulls and `"unknown"`, and a bot answers `"bot"` with nulls.
 *
 * @example
 * parseUserAgent(c.req.header("user-agent"))
 * // { browser: "Chrome", browserMajor: 141, deviceType: "desktop", os: "Windows", osVersion: "10" }
 */
export const parseUserAgent = (header: string | null | undefined): ParsedUserAgent => {
	const ua = (header ?? "").slice(0, MAX_LENGTH)
	if (BOT.test(ua)) return { browser: null, browserMajor: null, deviceType: "bot", os: null, osVersion: null }
	return { ...readBrowser(ua), ...readOs(ua) }
}
