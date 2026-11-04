/**
 * The files a package ships beside its code (plan 39 8.7): the README and the license file the run's metadata block
 * names, read once per run and written into every target's root as `README.md` and `LICENSE`, the names each registry
 * and forge reads. Each is UTF-8 text; one that cannot be read, or is not UTF-8, is refused naming its field. The icon
 * ships only into the C# package, NuGet being the one registry that shows one: a PNG or JPEG of at most 1 MB, its
 * bytes as given, refused when they are not the image its extension names.
 */
import { iconName, LICENSE, type Metadata, README } from "../emit/shared/metadata.ts"

/** Reads a file the metadata block names, by its path as given: its bytes. */
export type ReadFile = (path: string) => Uint8Array

// per-process-constant: text-codec
const UTF8 = /* @__PURE__ */ new TextDecoder("utf-8", { fatal: true })

/* NuGet's cap on a package icon */
const ICON_BYTES = 1024 * 1024

/* the signature each image format opens with, by the extensions that name it */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]

/** The bytes of the file `metadata[field]` names, or a refusal naming the field. */
function bytesOf(field: "icon" | "licenseFile" | "readme", path: string, read: ReadFile): Uint8Array {
	try {
		return read(path)
	} catch (error) {
		const why = (error as NodeJS.ErrnoException).code ?? (error as Error).message
		throw new Error(`Invalid metadata.${field}: ${JSON.stringify(path)} cannot be read (${why})`, { cause: error })
	}
}

/** The icon at `path`: a PNG or a JPEG as its extension names it, of at most 1 MB. */
function iconOf(path: string, read: ReadFile): Uint8Array {
	const bytes = bytesOf("icon", path, read)
	const signature = /\.png$/i.test(path) ? PNG : JPEG
	if (!signature.every((byte, i) => bytes[i] === byte))
		throw new Error(`Invalid metadata.icon: ${JSON.stringify(path)} is not the image its extension names`)
	if (bytes.length > ICON_BYTES) throw new Error(`Invalid metadata.icon: ${JSON.stringify(path)} is over NuGet's 1 MB`)
	return bytes
}

/** The text of the file `metadata[field]` names, or a refusal naming the field. */
function textOf(field: "licenseFile" | "readme", path: string, read: ReadFile): string {
	const bytes = bytesOf(field, path, read)
	try {
		return UTF8.decode(bytes)
	} catch (error) {
		throw new Error(`Invalid metadata.${field}: ${JSON.stringify(path)} is not UTF-8 text`, { cause: error })
	}
}

/** What a run ships beside the code, by the name each file takes in a package's root: every package's, and the icon. */
export type ShippedFiles = {
	readonly files: Readonly<Record<string, string>>
	readonly icon: Readonly<Record<string, Uint8Array>>
}

/** The README, license file and icon `metadata` names. */
export function shippedFiles(metadata: Metadata, read: ReadFile): ShippedFiles {
	const files: Record<string, string> = {}
	if (metadata.readme !== undefined) files[README] = textOf("readme", metadata.readme, read)
	if (metadata.licenseFile !== undefined) files[LICENSE] = textOf("licenseFile", metadata.licenseFile, read)
	const { icon } = metadata
	return { files, icon: icon === undefined ? {} : { [iconName(icon)]: iconOf(icon, read) } }
}
