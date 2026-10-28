/**
 * The bound of a test or hook that spawns a process in gen (honey/spawn-timeout requires one, never vitest's 5 s test
 * or 10 s hook default). A process start's cost is the runner's, not the code's: a cold Bun build took 1.6 s locally
 * and 6.8 s on a slow CI runner (run 40774978593, 4.3x). 60 s leaves that tail room; a leg whose own measurement says
 * more names its own (cli.test's SLOW). Core keeps its twin in its own test support (gen never imports core, nor core
 * gen's src); core's tests/structure/spawn-timeout-twins.test.ts holds the two equal.
 */
export const SPAWN_TIMEOUT = 60_000
