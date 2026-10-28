/**
 * The stdio server's file reader (bit 21 c): a path read under a hard root, realpath'd (no `..` or symlink out), opened
 * following no last link and never blocking, its descriptor a regular file, the one realpath named (device and inode),
 * within the cap, read to exactly its size. A hard link to outside the root is no path check's to see. A refusal names
 * its rule, never a path.
 */
import { constants, realpathSync, statSync } from "node:fs"
import { open, realpath, stat } from "node:fs/promises"
import { resolve, sep } from "node:path"

/** The calls a read makes: node's, or a test's around them. */
export type Disk = { readonly open: typeof open; readonly realpath: typeof realpath; readonly stat: typeof stat }

/* no last link followed, a FIFO never waited on */
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/** Throws `rule`, the reason a read is refused. */
const refuse = (rule: string): never => {
	throw new Error(rule)
}

/** A reader under `root`, `max` bytes a file; none when `root` is no directory. */
export function fileReader(root: string, max: number, disk: Disk = { open, realpath, stat }) {
	let base: string
	try {
		base = realpathSync(root)
		if (!statSync(base).isDirectory()) return undefined
		/* a root that resolves to nothing is no directory either */
	} catch {
		return undefined
	}
	const under = base.endsWith(sep) ? base : base + sep
	return async (path: string): Promise<Uint8Array> => {
		const none = () => refuse("names no file under the file root")
		/* nothing there, or a NUL byte: node's own error would name the path */
		const real = await disk.realpath(resolve(base, path)).catch(none)
		if (!real.startsWith(under)) refuse("leaves the file root")
		/* gone since realpath: no file */
		const seen = await disk.stat(real).catch(none)
		/* a socket, or a last link swapped in, opens not */
		const handle = await disk.open(real, FLAGS).catch(() => refuse("is no regular file"))
		try {
			const fd = await handle.stat()
			if (!fd.isFile()) refuse("is no regular file")
			if (fd.dev !== seen.dev || fd.ino !== seen.ino) refuse("changed while it was opened")
			if (fd.size > max) refuse(`is past the ${max}-byte file cap`)
			/* a byte past its size, which a grown file fills */
			const bytes = new Uint8Array(fd.size + 1)
			let got = 0
			for (let read = 1; read > 0 && got < bytes.length; got += read)
				({ bytesRead: read } = await handle.read(bytes, got, bytes.length - got, got))
			return got === fd.size ? bytes.subarray(0, got) : refuse("changed while it was read")
		} finally {
			await handle.close()
		}
	}
}
