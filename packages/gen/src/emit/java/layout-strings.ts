/**
 * google-java-format's StringWrapper, ported (bit 21 i7a): after layout, a string literal whose line passes the width
 * is cut at its whitespace and refilled, each later piece on its own line as `+ "…"`: at +4 when the literal opens its
 * `+` chain (or stands alone), else under its own quote.
 */
import { type Sink, WIDTH } from "./layout-doc.ts"

/*
 * StringWrapper.stringComponents: a literal's body cut before each whitespace character (and a `\t`), a run of
 * `\n`/`\r` escapes ending the piece it closes
 */
function piecesOf(body: string): string[] {
	const out: string[] = []
	let piece = ""
	let start = 0
	for (let i = 0; i < body.length; i += 1) {
		if (/\s/.test(body[i] as string) || body.startsWith("\\t", i)) {
			// a cut before it
		} else if (body.startsWith("\\r", i) || body.startsWith("\\n", i)) {
			while (body.startsWith("\\r", i) || body.startsWith("\\n", i)) i += 2
		} else continue
		piece += body.slice(start, i)
		out.push(piece)
		piece = ""
		start = i
	}
	if (piece !== "") out.push(piece)
	if (start < body.length) piece = body.slice(start)
	if (piece !== "") out.push(piece)
	return out
}

/** StringWrapper.reflow: the pieces greedily filled, the first line `width` wide, each later one six narrower. */
function reflow(start: number, trailing: number, pieces: readonly string[], first0: boolean): string {
	let room = WIDTH - start - 2
	const queue = [...pieces]
	const lines: string[] = []
	let first = first0
	while (queue.length > 0) {
		let length = 0
		const line: string[] = []
		if (queue.join("").length <= room) room -= trailing
		while (queue.length > 0 && (length <= 4 || length + (queue[0] as string).length <= room)) {
			const text = queue.shift() as string
			line.push(text)
			length += text.length
			if (text.endsWith("\\n") || text.endsWith("\\r")) break
		}
		if (line.length === 0) line.push(queue.shift() as string)
		lines.push(line.join(""))
		if (first) {
			room -= 6
			first = false
		}
	}
	return `"${lines.join(`"\n${" ".repeat(start + (first0 ? 4 : -2))}+ "`)}"`
}

/** The offset just past the string literal opening at `at`. */
function literalEnd(text: string, at: number): number {
	let i = at + 1
	while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1
	return i + 1
}

/** The laid-out `sink`'s text with every string literal whose line passes the width reflowed. */
export function wrapStrings({ strings, text }: Sink): string {
	const edits = strings.flatMap(({ at, first }) => {
		const end = literalEnd(text, at)
		const lineStart = text.lastIndexOf("\n", at - 1) + 1
		const newline = text.indexOf("\n", end)
		const lineEnd = newline === -1 ? text.length : newline
		if (lineEnd - lineStart <= WIDTH) return []
		return [{ at, end, text: reflow(at - lineStart, lineEnd - end, piecesOf(text.slice(at + 1, end - 1)), first) }]
	})
	return edits.reduceRight((out, edit) => out.slice(0, edit.at) + edit.text + out.slice(edit.end), text)
}
