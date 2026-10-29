/**
 * Java doc comments (bit 16 phase c1): spec text made safe and filled as google-java-format fills a javadoc. Code is
 * laid out by layout.ts (bit 21 i7a), which took over this file's list and assignment rules.
 */
import { invisible } from "../shared/escape.ts"

/** The longest line google-java-format keeps. */
const WIDTH = 100

/** Whether `cp` is a control, DEL, C1, the BOM, a line or paragraph separator or a bidi control: never raw in a doc. */
const control = (cp: number) =>
	cp < 0x20 || cp === 0x7f || cp === 0xfeff || cp === 0x2028 || cp === 0x2029 || invisible(cp)

/**
 * Spec text as a doc comment holds it: each control a space; every backslash `&#92;`, so none begins a `\u` escape,
 * which javac reads before it lexes, comments included (JLS 3.3); and `*\/` as `*&#47;`, so the comment never ends
 * early. Javadoc renders both entities as the characters they stand for.
 */
const docText = (text: string) =>
	[...text.toWellFormed()]
		.map((ch) => (control(ch.codePointAt(0) as number) ? " " : ch))
		.join("")
		.replace(/\\/g, "&#92;")
		.replace(/\*\//g, "*&#47;")

/**
 * A `/** … *\/` doc comment at `indent`, its text made safe (docText): one line when it fits in 100 columns, else
 * google-java-format's filled lines, each word on the first line it fits, after ` * `.
 */
export function docOf(raw: string, indent = "  "): string {
	const text = docText(raw)
	const one = `${indent}/** ${text} */`
	if (one.length <= WIDTH) return one
	return docBlock([filled(text, WIDTH - indent.length - " * ".length)], indent)
}

/**
 * A doc comment of several paragraphs, as google-java-format writes one: the first as it is, each later one after a
 * blank ` *` line and opened by `<p>`, every paragraph's text made safe (docText) and filled to 100 columns. One
 * paragraph is docOf.
 */
export function docParagraphs(raws: readonly string[], indent = "  "): string {
	if (raws.length === 1) return docOf(raws[0] as string, indent)
	const available = WIDTH - indent.length - " * ".length
	return docBlock(
		raws.map((raw, i) => filled(i === 0 ? docText(raw) : `<p>${docText(raw)}`, available)),
		indent,
	)
}

/** The words of `text` filled into lines of at most `available` columns, each word on the first line it fits. */
function filled(text: string, available: number): string[] {
	const lines: string[] = []
	let line = ""
	for (const word of text.split(/\s+/).filter((w) => w !== "")) {
		if (line !== "" && line.length + 1 + word.length > available) {
			lines.push(line)
			line = word
		} else {
			line = line === "" ? word : `${line} ${word}`
		}
	}
	lines.push(line)
	return lines
}

/** A `/** … *\/` block at `indent` of `paragraphs` (each its lines), a blank ` *` line between two. */
function docBlock(paragraphs: readonly (readonly string[])[], indent: string): string {
	const lines = paragraphs.flatMap((paragraph, i) => [...(i === 0 ? [] : [""]), ...paragraph])
	const body = lines.map((line) => (line === "" ? `${indent} *` : `${indent} * ${line}`))
	return [`${indent}/**`, ...body, `${indent} */`].join("\n")
}
