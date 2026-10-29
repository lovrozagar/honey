/**
 * The reference app's drop origin (bit 21 i0): a raw TCP listener relaying each request to the app in process and
 * ending the connection where the app's answer ends, without the chunked body's terminal chunk. A client reads every
 * byte the app sent, then a connection lost mid-answer: the grid's `stream/mid-drop`. A raw socket, because Bun's own
 * server finishes a body whose stream errors cleanly on 1.3 (the terminal chunk written) and resets it on 1.4.
 */
import { createServer, type Server, type Socket } from "node:net"

type FetchApp = { fetch(request: Request, env: Record<string, never>): Response | Promise<Response> }

/** The request head's lines: the request line, then each header field. */
function requestOf(head: string, origin: string): Request | string {
	const [line = "", ...fields] = head.split("\r\n")
	const [method, target] = line.split(" ")
	if (method === undefined || target === undefined) return `a request line that is not one: ${JSON.stringify(line)}`
	const headers = new Headers()
	for (const field of fields) {
		const colon = field.indexOf(":")
		if (colon > 0) headers.append(field.slice(0, colon).trim(), field.slice(colon + 1).trim())
	}
	/* Java's HttpClient sends `content-length: 0` on a GET: a zero length is no body */
	if ((headers.get("content-length") ?? "0") !== "0" || headers.has("transfer-encoding"))
		return "a request with a body: the drop origin relays bodiless requests only"
	return new Request(`${origin}${target}`, { headers, method })
}

/** Answer `head` through `app`, chunk by chunk, then end the connection with no terminal chunk. */
async function relay(app: FetchApp, socket: Socket, head: string, origin: string): Promise<void> {
	const request = requestOf(head, origin)
	if (typeof request === "string") {
		socket.end(`HTTP/1.1 501 Not Implemented\r\ncontent-length: ${Buffer.byteLength(request)}\r\n\r\n${request}`)
		return
	}
	const response = await app.fetch(request, {})
	let out = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`
	response.headers.forEach((value, name) => {
		if (name !== "connection" && name !== "content-length" && name !== "transfer-encoding")
			out += `${name}: ${value}\r\n`
	})
	socket.write(`${out}transfer-encoding: chunked\r\nconnection: close\r\n\r\n`)
	for await (const chunk of response.body ?? [])
		socket.write(`${chunk.byteLength.toString(16)}\r\n${Buffer.from(chunk)}\r\n`)
	socket.end()
}

/** Listen on an OS-assigned loopback port; resolves to the listener and its origin once it is up. */
export function listenDropFront(app: FetchApp): Promise<{ readonly server: Server; readonly url: string }> {
	return new Promise((resolve, reject) => {
		let url = ""
		const server = createServer((socket) => {
			let buffered = ""
			const onData = (data: Buffer) => {
				buffered += data.toString("latin1")
				const end = buffered.indexOf("\r\n\r\n")
				if (end === -1) return
				socket.off("data", onData)
				relay(app, socket, buffered.slice(0, end), url)
					/* a relay that fails mid-answer loses the connection, as a drop does */
					.catch(() => socket.destroy())
			}
			socket.on("data", onData)
			socket.on("error", () => socket.destroy())
		})
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
			resolve({ server, url })
		})
	})
}
