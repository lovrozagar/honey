/**
 * Nothing is swallowed silently (H17): every `catch` in core either reports what it caught (the
 * logger, onError, a report hook), passes it on (rethrows, errors the stream, converts it to the
 * answer), or carries a comment saying why there is nothing to report and who does.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = join(import.meta.dirname, "../../src")

/* a call that reports the failure, or one that hands it on */
const ACCOUNTED =
	/\.(error|warn|fatal)\(|\breport\w*\(|logFailure\(|transportFailed\(|onErrorFailed\(|\.report\?\.\(|fire\(report|\bthrow\b|controller\.error\(|Promise\.reject\(|\bconvert\(/

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) return sources(path)
		return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : []
	})
}

/** The text from `open` (an opening bracket) to its matching close, strings and comments skipped. */
function enclosed(text: string, open: number): string {
	const pairs: Record<string, string> = { "(": ")", "{": "}" }
	const close = pairs[text[open] as string] as string
	let depth = 0
	for (let i = open; i < text.length; i++) {
		const ch = text[i]
		if (ch === '"' || ch === "'" || ch === "`") {
			for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++
			continue
		}
		if (ch === text[open]) depth++
		else if (ch === close && --depth === 0) return text.slice(open, i + 1)
	}
	return text.slice(open)
}

const hasComment = (text: string) => /\/\*|\/\//.test(text)

/** Every catch site that neither accounts for its failure nor says why it need not. */
export function silentCatches(path: string, text: string): string[] {
	const lines = text.split("\n")
	const lineOf = (index: number) => text.slice(0, index).split("\n").length
	const out: string[] = []
	for (const match of text.matchAll(/\bcatch\b\s*(\([^)]*\))?\s*\{|\.catch\(/g)) {
		const at = match.index
		const line = lineOf(at)
		const before = lines[line - 2] ?? ""
		const body = enclosed(text, at + match[0].length - 1)
		const accounted =
			ACCOUNTED.test(body) || hasComment(body) || hasComment(lines[line - 1] ?? "") || hasComment(before)
		if (!accounted) out.push(`${relative(SRC, path)}:${line}`)
	}
	return out
}

describe("no silent failure in core (H17)", () => {
	it("every catch reports, passes on, or names why it need not", () => {
		const silent = sources(SRC).flatMap((path) => silentCatches(path, readFileSync(path, "utf8")))
		expect(silent).toEqual([])
	})

	it.each([
		["a bare swallow", "try { a() } catch {}", 1],
		["a swallowing promise", "p.catch(() => undefined)", 1],
		["a catch that logs", "try { a() } catch (e) { log.error({ err: e }) }", 0],
		["a catch that rethrows", "try { a() } catch (e) { throw e }", 0],
		["a catch that says why", "try { a() } catch {\n/* not a URL: the caller answers 400 */\nreturn null }", 0],
		["a promise catch that reports", "p.catch((e) => this.#options?.report?.(e))", 0],
		["a promise catch named on the line above", "/* the client left: nothing to tell */\np.catch(ignore)", 0],
	])("the checker: %s → %i silent", (_name, text, count) => {
		expect(silentCatches(join(SRC, "x.ts"), text)).toHaveLength(count)
	})
})
