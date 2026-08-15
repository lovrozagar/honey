/* Drift guards — if tsc stops applying @ts-expect-error, this file goes red. */

// @ts-expect-error — sentinel: string is not a number
const _n: number = "never"
// @ts-expect-error — sentinel: number is not a string
const _s: string = 123
// @ts-expect-error — sentinel: object is not a boolean
const _b: boolean = { foo: "bar" }

void _n
void _s
void _b
