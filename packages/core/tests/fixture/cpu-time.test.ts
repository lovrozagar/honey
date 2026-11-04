import { describe, expect, it } from "vitest"
import { cheapestCallCpuMs, threadCpuMs } from "./cpu-time.ts"

/* a 2 ms wait off the CPU: what a descheduled thread on a loaded runner spends, doing no work */
const lock = new Int32Array(new SharedArrayBuffer(4))
const offTheCpu = () => void Atomics.wait(lock, 0, 0, 2)

describe("cheapestCallCpuMs: a call's cost to this thread's CPU", () => {
	it("counts nothing for time the thread spends off the CPU", () => {
		expect(cheapestCallCpuMs(offTheCpu)).toBeLessThan(0.2)
	}, 60_000)

	it("counts the work a call does: four times the work costs about four times as much", () => {
		const work = (n: number) => () => {
			let sum = 0
			for (let i = 0; i < n; i++) sum += i % 7
			return sum
		}
		const ratio = cheapestCallCpuMs(work(400_000)) / cheapestCallCpuMs(work(100_000))
		expect([ratio > 2, ratio < 8]).toEqual([true, true])
	}, 60_000)

	it("threadCpuMs reads a one-shot cost: work moves it, waiting off the CPU does not", () => {
		const waitedFrom = threadCpuMs()
		for (let i = 0; i < 25; i++) offTheCpu()
		const waited = threadCpuMs() - waitedFrom
		const workedFrom = threadCpuMs()
		let sum = 0
		for (let i = 0; i < 20_000_000; i++) sum += i % 7
		const worked = threadCpuMs() - workedFrom
		expect([sum > 0, waited < 5, worked > 5]).toEqual([true, true, true])
	})
})
