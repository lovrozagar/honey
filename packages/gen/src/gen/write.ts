/**
 * A target's files written under its directory (bit 19 h1, carry-in #2): each written only when its bytes differ,
 * through a temp file renamed over it, and listed with its sha256 in the directory's manifest. A regeneration deletes
 * a file only when the previous manifest lists it, this run does not emit it, and its bytes still hash as listed: a
 * hand-edited one is kept and named. Every path stays under the directory and no symlink is followed; without a
 * manifest nothing is deleted. The hash lives in the manifest, so the emitted bytes carry no header (Q6).
 */
import { createHash } from "node:crypto"
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

/** The manifest a target's directory keeps: each file it wrote, by its path, with its sha256. */
export const MANIFEST = ".honey-generated.json"

/** What a write did: the files rewritten, the stale ones deleted, and the edited stale ones kept. */
export type Written = { readonly deleted: string[]; readonly kept: string[]; readonly written: string[] }

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

/** Whether `path` is a symlink, a dangling one included. */
function isLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink()
	} catch {
		return false
	}
}

/** `rel` under `dir`, refused when it escapes it or passes through a symlink (the directory's own included). */
function confined(dir: string, rel: string): string {
	const path = resolve(dir, rel)
	const inside = relative(dir, path)
	if (isAbsolute(rel) || inside === "" || inside.startsWith("..") || isAbsolute(inside))
		throw new Error(`${rel}: the path escapes ${dir}`)
	let at = dir
	for (const part of ["", ...inside.split(sep)]) {
		at = join(at, part)
		if (isLink(at)) throw new Error(`${rel}: a symlink in its path is refused`)
	}
	return path
}

/** Write `text` to `path` only when its bytes differ, through a temp file renamed over it; whether it was written. */
export function writeFileIfChanged(path: string, text: string): boolean {
	if (existsSync(path) && readFileSync(path, "utf8") === text) return false
	mkdirSync(dirname(path), { recursive: true })
	const temp = join(dirname(path), `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
	writeFileSync(temp, text)
	renameSync(temp, path)
	return true
}

/** The previous run's listing, or none when there is no readable manifest. */
function listed(dir: string): Readonly<Record<string, string>> {
	try {
		const files = (JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as { files?: unknown }).files
		return typeof files === "object" && files !== null && !Array.isArray(files) ? (files as Record<string, string>) : {}
	} catch {
		return {}
	}
}

/** Remove the directories under `dir` that deleting `path` left empty. */
function prune(dir: string, path: string): void {
	for (let at = dirname(path); at !== dir && at.startsWith(dir + sep) && readdirSync(at).length === 0; at = dirname(at))
		rmdirSync(at)
}

/** `files` written under `dir`, the manifest updated, and the previous run's stale, unedited files deleted. */
export function writeTarget(dir: string, files: Readonly<Record<string, string>>): Written {
	const root = resolve(dir)
	const paths = Object.keys(files).map((rel) => [rel, confined(root, rel)] as const)
	const previous = listed(root)
	const written = paths.filter(([rel, path]) => writeFileIfChanged(path, files[rel] as string)).map(([rel]) => rel)
	const [deleted, kept]: [string[], string[]] = [[], []]
	for (const [rel, hash] of Object.entries(previous)) {
		if (Object.hasOwn(files, rel)) continue
		let path: string
		try {
			path = confined(root, rel)
		} catch {
			kept.push(rel)
			continue
		}
		/* a deleted file or directory is already gone (R7) */
		if (!existsSync(path)) continue
		if (!lstatSync(path).isFile() || sha256(readFileSync(path)) !== hash) {
			kept.push(rel)
			continue
		}
		unlinkSync(path)
		prune(root, path)
		deleted.push(rel)
	}
	const manifest = Object.fromEntries(
		Object.keys(files)
			.sort()
			.map((rel) => [rel, sha256(files[rel] as string)]),
	)
	writeFileIfChanged(join(root, MANIFEST), `${JSON.stringify({ files: manifest }, null, "\t")}\n`)
	return { deleted, kept, written }
}
