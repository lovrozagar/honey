/**
 * A local HTTP server answering every request with a large body, written only as the client takes it: `bytes`, that
 * many bytes streamed in 64 KiB chunks under backpressure, or a buffer sent as it is (a gzip bomb, encoded outside
 * any timed window). It counts the bytes it wrote, so a leg can hold a client to reading a bounded share of them.
 */
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

export type Flood = {
	readonly url: string
	/** the body bytes written so far, across every request */
	written(): number
	close(): Promise<void>
}

/** A flood server answering `status` with `body` under `headers`, listening on an OS-picked loopback port. */
export async function flood(
	body: number | Buffer,
	headers: Readonly<Record<string, string>>,
	status = 200,
): Promise<Flood> {
	const chunk64 = Buffer.alloc(64 * 1024, 0x61)
	let written = 0
	const server = createServer((req, res) => {
		req.resume()
		res.writeHead(status, headers)
		if (Buffer.isBuffer(body)) {
			written += body.byteLength
			res.end(body)
			return
		}
		let left = body
		let closed = false
		res.on("close", () => (closed = true))
		const pump = () => {
			while (left > 0 && !closed) {
				const chunk = left >= chunk64.byteLength ? chunk64 : chunk64.subarray(0, left)
				left -= chunk.byteLength
				written += chunk.byteLength
				if (!res.write(chunk)) return void res.once("drain", pump)
			}
			if (!closed) res.end()
		}
		pump()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as AddressInfo
	return {
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections()
				server.close((error) => (error ? reject(error) : resolve()))
			}),
		url: `http://127.0.0.1:${port}`,
		written: () => written,
	}
}
