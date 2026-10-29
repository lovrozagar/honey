/**
 * google-java-format 1.37's layout engine, ported (bit 21 i7a): its `Doc`, `OpsBuilder` and `DocBuilder`. Ops (open a
 * level, close it, a token, a space, a break) become a tree of levels. A token joins the level of the latest break,
 * not the innermost open one (DocBuilder's `appendLevel`), so text after a level counts toward that level's last
 * split. A level that fits in 100 columns stays on one line; else each of its own breaks is taken: a unified one
 * always, an independent one when the text up to its next break does not fit, or after a split that did not fit. A
 * break indents to its level's indent plus its own, and an `If` indent reads whether a tagged break was taken.
 */

/** google-java-format's line width. */
export const WIDTH = 100

/* a forced break is "wider" than any line (Doc.MAX_LINE_WIDTH) */
const MAX = 1000

/** A break that an `If` indent reads: taken or not, recorded as the layout runs. */
export type Tag = { taken: boolean }
/** An indent: a constant, or one that depends on whether a tagged break was taken (Indent.If). */
export type Indent = number | { readonly tag: Tag; readonly onBreak: number; readonly onFlat: number }
export type Fill = "unified" | "independent" | "forced"

const evalIndent = (indent: Indent): number =>
	typeof indent === "number" ? indent : indent.tag.taken ? indent.onBreak : indent.onFlat
/** Indent.If: `onBreak` when `tag`'s break was taken, else `onFlat`. */
export const ifTaken = (tag: Tag, onBreak: number, onFlat = 0): Indent => ({ onBreak, onFlat, tag })

type Level = {
	readonly k: "level"
	readonly indent: Indent
	readonly docs: Doc[]
	oneLine: boolean
	splits: Doc[][]
	breaks: Break[]
}
type Break = {
	readonly k: "break"
	readonly fill: Fill
	readonly flat: string
	readonly indent: Indent
	readonly tag: Tag | undefined
	broken: boolean
	newIndent: number
}
/**
 * A token; `str` marks a string literal StringWrapper may reflow: `first` when it opens its `+` chain (or stands
 * alone), `later` after a non-literal operand.
 */
type Text = { readonly k: "text"; readonly text: string; readonly str?: "first" | "later" }
type Doc = Text | Level | Break

const level = (indent: Indent): Level => ({ breaks: [], docs: [], indent, k: "level", oneLine: false, splits: [] })

function widthOf(doc: Doc): number {
	if (doc.k === "text") return doc.text.length
	if (doc.k === "break") return doc.fill === "forced" ? MAX : doc.flat.length
	return sumOf(doc.docs)
}
function sumOf(docs: readonly Doc[]): number {
	let sum = 0
	for (const doc of docs) {
		sum += widthOf(doc)
		if (sum >= MAX) return MAX
	}
	return sum
}

type State = {
	readonly lastIndent: number
	readonly indent: number
	readonly column: number
	readonly mustBreak: boolean
}
const fresh = (indent: number, column: number): State => ({ column, indent, lastIndent: indent, mustBreak: false })

function compute(doc: Doc, state: State): State {
	if (doc.k === "text") return { ...state, column: state.column + doc.text.length }
	if (doc.k === "break") throw new Error("a break is laid out by its level")
	const own = widthOf(doc)
	if (state.column + own <= WIDTH) {
		doc.oneLine = true
		return { ...state, column: state.column + own }
	}
	const broken = computeBroken(doc, fresh(state.indent + evalIndent(doc.indent), state.column))
	return { ...state, column: broken.column }
}

function computeBroken(doc: Level, start: State): State {
	doc.splits = [[]]
	doc.breaks = []
	for (const child of doc.docs) {
		if (child.k === "break") {
			doc.breaks.push(child)
			doc.splits.push([])
		} else (doc.splits.at(-1) as Doc[]).push(child)
	}
	let state = breakAndSplit(start, undefined, doc.splits[0] as Doc[])
	doc.breaks.forEach((brk, i) => {
		state = breakAndSplit(state, brk, doc.splits[i + 1] as Doc[])
	})
	return state
}

function breakAndSplit(state: State, brk: Break | undefined, split: readonly Doc[]): State {
	const breakWidth = brk === undefined ? 0 : widthOf(brk)
	const splitWidth = sumOf(split)
	const shouldBreak = brk?.fill === "unified" || state.mustBreak || state.column + breakWidth + splitWidth > WIDTH
	let next = state
	if (brk !== undefined) {
		if (brk.tag !== undefined) brk.tag.taken = shouldBreak
		brk.broken = shouldBreak
		if (shouldBreak) {
			brk.newIndent = Math.max(state.lastIndent + evalIndent(brk.indent), 0)
			next = { ...state, column: brk.newIndent }
		} else next = { ...state, column: state.column + brk.flat.length }
	}
	const room = next.column + splitWidth <= WIDTH
	next = { ...next, mustBreak: false }
	for (const doc of split) next = compute(doc, next)
	return room ? next : { ...next, mustBreak: true }
}

/** The text written so far, and where each string literal starts in it. */
export type Sink = { text: string; readonly strings: { readonly at: number; readonly first: boolean }[] }

function write(doc: Doc, out: Sink): void {
	if (doc.k === "text") put(doc, out)
	else if (doc.k === "break") out.text += doc.broken ? `\n${" ".repeat(doc.newIndent)}` : doc.flat
	else if (doc.oneLine) for (const child of doc.docs) writeFlat(child, out)
	else {
		for (const child of doc.splits[0] ?? []) write(child, out)
		doc.breaks.forEach((brk, i) => {
			write(brk, out)
			for (const child of doc.splits[i + 1] ?? []) write(child, out)
		})
	}
}
function writeFlat(doc: Doc, out: Sink): void {
	if (doc.k === "level") for (const child of doc.docs) writeFlat(child, out)
	else if (doc.k === "text") put(doc, out)
	else out.text += doc.flat
}
function put(doc: Text, out: Sink): void {
	if (doc.str !== undefined) out.strings.push({ at: out.text.length, first: doc.str === "first" })
	out.text += doc.text
}

/** The op builder: GJF's OpsBuilder and DocBuilder in one, building the doc as the ops arrive. */
export class Builder {
	private readonly base = level(0)
	private readonly stack: Level[] = [this.base]
	private append: Level = this.base

	open(indent: Indent): void {
		this.stack.push(level(indent))
	}
	close(): void {
		const top = this.stack.pop() as Level
		;(this.stack.at(-1) as Level).docs.push(top)
	}
	token(text: string): void {
		this.append.docs.push({ k: "text", text })
	}
	/** a literal token, marked when it is a string, so StringWrapper may reflow it */
	literal(text: string, chained = false): void {
		this.append.docs.push(
			text.startsWith('"') ? { k: "text", str: chained ? "later" : "first", text } : { k: "text", text },
		)
	}
	space(): void {
		this.token(" ")
	}
	brk(fill: Fill, flat: string, indent: Indent = 0, tag?: Tag): void {
		this.append = this.stack.at(-1) as Level
		this.append.docs.push({ broken: false, fill, flat, indent, k: "break", newIndent: -1, tag })
	}
	/** breakOp: a unified break */
	breakOp(flat = "", indent: Indent = 0): void {
		this.brk("unified", flat, indent)
	}
	/** breakToFill: an independent break */
	breakToFill(flat = ""): void {
		this.brk("independent", flat)
	}
	forced(): void {
		this.brk("forced", "")
	}
	/** breakFillList: an independent break in a level of its own */
	breakFill(): void {
		this.open(0)
		this.brk("independent", " ")
		this.close()
	}

	/** The doc laid out from `indent` columns, as GJF's block level lays out one statement: its text and literals. */
	laid(indent: number): Sink {
		computeBroken(this.base, fresh(indent, indent))
		const out: Sink = { strings: [], text: " ".repeat(indent) }
		write(this.base, out)
		return out
	}
}
