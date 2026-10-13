/** Compile-time assertions. These files are checked by `tsc -p tsconfig.types.json`. */

export type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

export type Extends<A, B> = [A] extends [B] ? true : false

export type IsNever<T> = [T] extends [never] ? true : false

export type IsUnknown<T> = Eq<T, unknown>

export type Expect<T extends true> = T
