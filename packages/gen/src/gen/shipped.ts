/**
 * The files a package ships beside its code (plan 39 8.7): the README and the license file the run's metadata block
 * names, read once per run and written into every target's root as `README.md` and `LICENSE`, the names each registry
 * and forge reads. Each is UTF-8 text; one that cannot be read, or is not UTF-8, is refused naming its field.
 */
import { LICENSE, type Metadata, README } from "../emit/shared/metadata.ts"

/** Reads a file the metadata block names, by its path as given: its bytes. */
export type ReadFile = (path: string) => Uint8Array

// per-process-constant: text-codec
const UTF8 = /* @__PURE__ */ new TextDecoder("utf-8", { fatal: true })

/** The text of the file `metadata[field]` names, or a refusal naming the field. */
function textOf(field: "licenseFile" | "readme", path: string, read: ReadFile): string {
	let bytes: Uint8Array
	try {
		bytes = read(path)
	} catch (error) {
		const why = (error as NodeJS.ErrnoException).code ?? (error as Error).message
		throw new Error(`Invalid metadata.${field}: ${JSON.stringify(path)} cannot be read (${why})`, { cause: error })
	}
	try {
		return UTF8.decode(bytes)
	} catch (error) {
		throw new Error(`Invalid metadata.${field}: ${JSON.stringify(path)} is not UTF-8 text`, { cause: error })
	}
}

/** The README and license file `metadata` names, by the name each takes in a package's root. */
export function shippedFiles(metadata: Metadata, read: ReadFile): Readonly<Record<string, string>> {
	const files: Record<string, string> = {}
	if (metadata.readme !== undefined) files[README] = textOf("readme", metadata.readme, read)
	if (metadata.licenseFile !== undefined) files[LICENSE] = textOf("licenseFile", metadata.licenseFile, read)
	return files
}
