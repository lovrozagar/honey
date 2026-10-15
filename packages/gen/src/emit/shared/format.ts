/**
 * The post-pass over emitted files (F4), dispatched by file extension: oxfmt for TypeScript, each
 * later target's formatter beside it. gen never imports a formatter; the caller passes the ones that
 * resolve (optional peers, like ts-morph for extract). Without one a file goes out as emitted, which
 * is already valid source.
 */

/** The oxfmt options emitted code is formatted with: honey's own style. */
export type FormatOptions = { readonly printWidth: number; readonly semi: boolean; readonly useTabs: boolean }

/** A formatter as the post-pass calls it: oxfmt's `format`, or another target's adapted to it. */
export type Formatter = (
	fileName: string,
	source: string,
	options: FormatOptions,
) => Promise<{ code: string; errors: readonly unknown[] }>

export const EMIT_STYLE: FormatOptions = { printWidth: 120, semi: false, useTabs: true }

/** The formatters that resolved, by the file extension they format (`ts`). */
export type Formatters = { readonly [extension: string]: Formatter }

/** `files`, each run through the formatter for its extension; a file without one as it is. */
export async function formatFiles(
	files: Readonly<Record<string, string>>,
	formatters: Formatters,
): Promise<Record<string, string>> {
	const out: Record<string, string> = { ...files }
	for (const [name, text] of Object.entries(files)) {
		const extension = name.slice(name.lastIndexOf(".") + 1)
		const formatter = Object.hasOwn(formatters, extension) ? formatters[extension] : undefined
		if (formatter === undefined) continue
		const { code, errors } = await formatter(name, text, EMIT_STYLE)
		/* an emitter wrote text that does not parse: a bug to surface, never a file to write */
		if (errors.length > 0) throw new Error(`could not format ${name}: ${JSON.stringify(errors[0])}`)
		out[name] = code
	}
	return out
}
