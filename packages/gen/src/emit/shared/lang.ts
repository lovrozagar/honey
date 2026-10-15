/**
 * Naming shared by every emitter and the IR: words out of any identifier-ish text, joined per
 * language convention, and the one locale-free string order.
 */

/** Order by UTF-16 code unit, never by locale: the same on every machine. */
export function compareCodeUnits(a: string, b: string): number {
	if (a === b) return 0
	return a < b ? -1 : 1
}

/** The ASCII alphanumeric words of `raw`: `user-id`, `user_id` and `userId` are all [user, id]. */
export function words(raw: string): string[] {
	return raw
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter((word) => word.length > 0)
}

/** The words joined PascalCase, each keeping its inner case: `user-id` → `UserId`, `getHTTP` → `GetHTTP`. */
export function pascalWords(raw: string): string {
	return words(raw)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("")
}
