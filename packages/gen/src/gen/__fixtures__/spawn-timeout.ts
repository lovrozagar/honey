/**
 * The bound of a test or hook that spawns a process, core's and gen's alike (honey/spawn-timeout requires one, never
 * vitest's 5 s test or 10 s hook default). A process start's cost is the runner's, not the code's: stack-hook.test's
 * cold Bun build took 1.6 s here and 6.8 s on a slow CI runner (run 40774978593, 4.3x); init.test's bun serve took
 * 0.3-0.6 s here and once passed 5 s in a full parallel run (ab42a96). 60 s, the bound core's spawning files already
 * carried privately, leaves that tail room. A leg whose own measurement says more passes its own bound.
 */
export const SPAWN_TIMEOUT = 60_000
