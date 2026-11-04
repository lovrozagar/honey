import { describe, expect, it } from "vitest"
import { cheapestCallCpuMs } from "./cpu-time.ts"

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
})
