/**
 * The types an app's generated `_gen/types.gen.d.ts` meets core through. `HoneyCodegen` is empty
 * until codegen augments it (`interface HoneyCodegen { routeSelector: RouteSelector }`), so an
 * ungenerated app keeps plain strings. Type-only.
 */
import type { ApplyOutput } from "./output-types.ts"

/** Augmented by the generated types: `routeSelector` names every documented route as `"METHOD /path"`. */
export interface HoneyCodegen {}

/** The route selectors codegen `C` declares; any string when it declares none. */
export type SelectorOf<C> = C extends { routeSelector: infer R } ? (R extends string ? R : string) : string

/** An `invalidate` target: one of the app's route selectors once codegen ran, any string before. */
export type RouteSelectorOf = SelectorOf<HoneyCodegen>

/** A route ctx with `ctx.res` narrowed to what the route declares: the generated `Routes` ctx types. */
export type WithOutput<TCtx, TOutput> = ApplyOutput<TCtx, TOutput>
