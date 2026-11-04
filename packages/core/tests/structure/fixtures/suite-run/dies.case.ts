import { expect, it } from "vitest"

/* the worker goes as a crash or an out-of-memory kill would take it: no result, no error of its own */
it("takes its worker down", () => {
	expect(process.kill(process.pid, "SIGKILL")).toBe(true)
})
