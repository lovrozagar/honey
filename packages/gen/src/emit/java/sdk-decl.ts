/**
 * Java declaration text (bit 16 phase c1): the layout rules google-java-format applies to the shapes the emitter writes,
 * so the emitted text is its canonical form (format.test.ts holds every file to it). A list of items after a prefix
 * stays on one line when it fits in 100 columns; else its items share one continuation line at +4 when they fit there,
 * else each takes its own line. The suffix closes the last line. An assignment whose right side does not fit breaks
 * after `=` first.
 */
import { invisible } from "../shared/escape.ts"

/** The longest line google-java-format keeps. */
const WIDTH = 100

/** A list of `items` after `prefix` and before `suffix`, at `indent`: the one-line, shared-line, or one-per-line form. */
export function layout(prefix: string, items: readonly string[], suffix: string, indent = ""): string[] {
	const one = `${indent}${prefix}${items.join(", ")}${suffix}`
	if (one.length <= WIDTH || items.length === 0) return [one]
	const inner = `${indent}    ${items.join(", ")}${suffix}`
	if (inner.length <= WIDTH) return [`${indent}${prefix}`, inner]
	const last = items.length - 1
	return [`${indent}${prefix}`, ...items.map((item, i) => `${indent}    ${item}${i < last ? "," : suffix}`)]
}

/** An assignment's right side: `items` between `prefix` and `suffix`. */
export type Rhs = { readonly prefix: string; readonly items: readonly string[]; readonly suffix: string }

/** `lhs = prefix items suffix` at `indent`: one line when it fits, else broken after `=` with the right side laid out. */
export function assigned(indent: string, lhs: string, { items, prefix, suffix }: Rhs): string[] {
	const one = `${indent}${lhs} = ${prefix}${items.join(", ")}${suffix}`
	if (one.length <= WIDTH) return [one]
	return [`${indent}${lhs} =`, ...layout(prefix, items, suffix, `${indent}    `)]
}

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
