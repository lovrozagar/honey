import { afterEach, describe, expect, it, vi } from "vitest"
import { generatorStream, type ProducerSink, producerStream } from "./producer-stream.ts"

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes)

/** Every chunk the body yields, decoded. */
async function chunksOf(stream: ReadableStream<Uint8Array>): Promise<string[]> {
	const out: string[] = []
	for await (const chunk of stream) out.push(decode(chunk))
	return out
}

/** A producer that records what happened to it; it writes `parts`, then waits for `hold` if given. */
function recording(parts: string[], hold?: Promise<void>) {
	const seen = { ended: 0, runs: 0, sink: undefined as ProducerSink | undefined }
	const start = async (sink: ProducerSink) => {
		seen.runs++
		seen.sink = sink
		sink.onEnd(() => seen.ended++)
		for (const part of parts) await sink.write(encode(part))
		await hold
	}
	return { seen, start }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("producerStream: when the producer runs", () => {
	it("on the first read, never for a body nobody reads", async () => {
		const unread = recording(["a"])
		producerStream(unread.start)
		const read = recording(["a", "b"])
		const body = producerStream(read.start)
		await Promise.resolve()
		expect([unread.seen.runs, read.seen.runs]).toEqual([0, 0])
		expect([await chunksOf(body), read.seen.runs, read.seen.ended, unread.seen.runs]).toEqual([["a", "b"], 1, 1, 0])
	})

	it("ends without running when the request signal already aborted", async () => {
		const request = new AbortController()
		request.abort(new DOMException("gone", "AbortError"))
		const producer = recording(["a"])
		const body = producerStream(producer.start, { signal: () => request.signal })
		expect([await chunksOf(body), producer.seen.runs]).toEqual([[], 0])
	})
})

describe("producerStream: backpressure", () => {
	it("a write resolves only when the reader asks for more", async () => {
		let written = 0
		const body = producerStream(async (sink) => {
			for (let i = 0; i < 5; i++) {
				await sink.write(encode(String(i)))
				written++
			}
		})
		const reader = body.getReader()
		await reader.read()
		await new Promise((resolve) => setTimeout(resolve, 10))
		const afterOneRead = written
		await reader.read()
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect([afterOneRead, written]).toEqual([0, 1])
		await reader.cancel()
	})
})

describe("producerStream: the end comes once", () => {
	it("close and error are idempotent, and the first end wins", async () => {
		const body = producerStream((sink) => {
			sink.close()
			sink.close()
			sink.error(new Error("late"))
		})
		expect(await chunksOf(body)).toEqual([])
		const broken = producerStream((sink) => {
			sink.error(new Error("first"))
			sink.close()
		})
		await expect(chunksOf(broken)).rejects.toThrow("first")
	})

	it("a cancelled body aborts the producer's signal, rejects its writes, and cleans up once", async () => {
		const release = Promise.withResolvers<void>()
		const producer = recording(["a"], release.promise)
		const body = producerStream(producer.start)
		const reader = body.getReader()
		await reader.read()
		await reader.cancel(new Error("client left"))
		const sink = producer.seen.sink as ProducerSink
		const late = sink.write(encode("late"))
		expect([sink.signal.aborted, (sink.signal.reason as Error).message, sink.closed, producer.seen.ended]).toEqual([
			true,
			"client left",
			true,
			1,
		])
		await expect(late).rejects.toThrow("client left")
		sink.onEnd(() => producer.seen.ended++)
		expect(producer.seen.ended).toBe(2)
		release.resolve()
	})

	it("a pending write rejects when the reader cancels", async () => {
		let pending: Promise<void> | undefined
		const body = producerStream(async (sink) => {
			await sink.write(encode("a"))
			pending = sink.write(encode("b"))
			await pending.catch(() => {})
		})
		const reader = body.getReader()
		await reader.read()
		await reader.read()
		await reader.cancel()
		await expect(pending).rejects.toMatchObject({ name: "AbortError" })
	})
})

describe("producerStream: the request signal, late writes and cleanups", () => {
	it("an unawaited write after the end never surfaces as an unhandled rejection", async () => {
		const unhandled = vi.fn()
		process.on("unhandledRejection", unhandled)
		const body = producerStream((sink) => {
			sink.close()
			void sink.write(encode("ignored"))
		})
		expect(await chunksOf(body)).toEqual([])
		await new Promise((resolve) => setTimeout(resolve, 10))
		process.off("unhandledRejection", unhandled)
		expect(unhandled).not.toHaveBeenCalled()
	})

	it("the request signal aborting mid-stream ends the body cleanly and aborts the producer", async () => {
		const request = new AbortController()
		const producer = recording(["a"], new Promise(() => {}))
		const body = producerStream(producer.start, { signal: () => request.signal })
		const reader = body.getReader()
		expect(decode((await reader.read()).value)).toBe("a")
		request.abort(new DOMException("shutting down", "AbortError"))
		const sink = producer.seen.sink as ProducerSink
		expect([await reader.read(), sink.signal.aborted, producer.seen.ended]).toEqual([
			{ done: true, value: undefined },
			true,
			1,
		])
	})

	it("cleanups that throw do not stop the others", async () => {
		const ran: string[] = []
		const body = producerStream((sink) => {
			sink.onEnd(() => {
				throw new Error("bad cleanup")
			})
			sink.onEnd(() => ran.push("second"))
		})
		expect([await chunksOf(body), ran]).toEqual([[], ["second"]])
	})
})

describe("producerStream: failures", () => {
	it("a producer that throws or rejects breaks the body after what it wrote, and is reported", async () => {
		const report = vi.fn()
		const boom = new Error("boom")
		const rejecting = producerStream(
			async (sink) => {
				await sink.write(encode("partial"))
				throw boom
			},
			{ report },
		)
		const reader = rejecting.getReader()
		expect(decode((await reader.read()).value)).toBe("partial")
		await expect(reader.read()).rejects.toBe(boom)
		const throwing = producerStream(
			() => {
				throw boom
			},
			{ report },
		)
		await expect(chunksOf(throwing)).rejects.toBe(boom)
		expect(report.mock.calls).toEqual([[boom], [boom]])
	})

	// v0: 48572c159f
	it("an abort the producer rethrows after a cancel is not reported", async () => {
		const report = vi.fn()
		const body = producerStream(
			async (sink) => {
				await sink.write(encode("a"))
				await sink.write(encode("b"))
			},
			{ report },
		)
		const reader = body.getReader()
		await reader.read()
		await reader.cancel()
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(report).not.toHaveBeenCalled()
	})
})

describe("producerStream: failures after the reader left", () => {
	it("after a cancel, an AbortError of the producer's own is not reported; any other error is", async () => {
		const report = vi.fn()
		const settle = (thrown: unknown) =>
			producerStream(
				async (sink) => {
					sink.write(encode("a")).catch(() => {})
					await new Promise((resolve) => sink.onEnd(() => resolve(undefined)))
					throw thrown
				},
				{ report },
			)
		const typeError = new TypeError("after the end")
		for (const thrown of [new DOMException("fetch aborted", "AbortError"), typeError]) {
			const reader = settle(thrown).getReader()
			await reader.read()
			await reader.cancel()
		}
		await vi.waitFor(() => expect(report.mock.calls).toEqual([[typeError]]))
	})

	it("an unreported failure with no report option still breaks the body", async () => {
		await expect(chunksOf(producerStream(() => Promise.reject(new Error("quiet"))))).rejects.toThrow("quiet")
	})
})

function* syncValues() {
	yield "a"
	yield encode("b")
}

async function* asyncValues() {
	yield "c"
	await Promise.resolve()
	yield "d"
}

function* noValues() {}

describe("generatorStream: values", () => {
	it("yields the generator's values in order, strings encoded, sync or async; an empty one is an empty body", async () => {
		expect([
			await chunksOf(generatorStream(syncValues())),
			await chunksOf(generatorStream(asyncValues())),
			await chunksOf(generatorStream(noValues())),
		]).toEqual([["a", "b"], ["c", "d"], []])
	})
})

describe("generatorStream: ending early", () => {
	// v0: 41f85937d3
	it("runs the generator's finally when the reader cancels", async () => {
		const cleaned = Promise.withResolvers<string>()
		async function* endless() {
			try {
				for (;;) yield "tick"
			} finally {
				cleaned.resolve("finally ran")
			}
		}
		const reader = generatorStream(endless()).getReader()
		await reader.read()
		await reader.cancel()
		expect(await cleaned.promise).toBe("finally ran")
	})

	it("ends cleanly and runs finally when the request signal aborts, and never starts when it already had", async () => {
		const request = new AbortController()
		const cleaned = Promise.withResolvers<string>()
		async function* endless() {
			try {
				for (;;) {
					yield "tick"
					await new Promise((resolve) => setTimeout(resolve, 5))
				}
			} finally {
				cleaned.resolve("finally ran")
			}
		}
		const reader = generatorStream(endless(), { signal: () => request.signal }).getReader()
		await reader.read()
		request.abort()
		expect([await reader.read(), await cleaned.promise]).toEqual([{ done: true, value: undefined }, "finally ran"])
		let started = false
		function* never() {
			started = true
			yield "x"
		}
		expect([await chunksOf(generatorStream(never(), { signal: () => request.signal })), started]).toEqual([[], false])
	})
})

describe("generatorStream: after the reader left", () => {
	it("a value or a throw that arrives after the reader cancelled is dropped, never reported", async () => {
		const report = vi.fn()
		const gate = Promise.withResolvers<void>()
		async function* slow(fail: boolean) {
			yield "first"
			await gate.promise
			if (fail) throw new Error("too late")
			yield "second"
		}
		const readers = [
			generatorStream(slow(false), { report }).getReader(),
			generatorStream(slow(true), { report }).getReader(),
		]
		for (const reader of readers) await reader.read()
		const pending = readers.map((reader) => reader.read())
		/* both pulls are now waiting on the generators */
		await new Promise((resolve) => setTimeout(resolve, 5))
		await Promise.all(readers.map((reader) => reader.cancel()))
		gate.resolve()
		expect(await Promise.all(pending)).toEqual([
			{ done: true, value: undefined },
			{ done: true, value: undefined },
		])
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(report).not.toHaveBeenCalled()
	})
})

describe("generatorStream: failures", () => {
	it("a generator that throws breaks the body after the values before it, and is reported", async () => {
		const report = vi.fn()
		const boom = new Error("boom")
		function* failing() {
			yield "before"
			throw boom
		}
		const reader = generatorStream(failing(), { report }).getReader()
		expect(decode((await reader.read()).value)).toBe("before")
		await expect(reader.read()).rejects.toBe(boom)
		expect(report.mock.calls).toEqual([[boom]])
	})

	it("reports a finally that throws on cancel", async () => {
		const report = vi.fn()
		const boom = new Error("finally failed")
		function* faulty() {
			try {
				yield "a"
				yield "b"
			} finally {
				// oxlint-disable-next-line no-unsafe-finally -- the failure under test
				throw boom
			}
		}
		const reader = generatorStream(faulty(), { report }).getReader()
		await reader.read()
		await reader.cancel()
		await vi.waitFor(() => expect(report.mock.calls).toEqual([[boom]]))
	})
})
