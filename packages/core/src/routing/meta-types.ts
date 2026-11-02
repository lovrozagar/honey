/**
 * The meta type machinery, split from app-types.ts for the 300-line limit (bit 22 a): what a handle declares,
 * what a chain `.meta(values)` records, what a route must still pass, and what the route record leaves out.
 */

/** `TMeta` defaults to `never`, and `never & X` is `never`: accumulated meta starts at `{}`. */
export type InitAccMeta<TMeta> = [TMeta] extends [never] ? {} : TMeta

/** Chain `.meta(values)` at the type level: a phantom optional key, so routes see the values without having to repeat them. */
declare const CHAIN_META: unique symbol

/** The handle's meta after a chain `.meta(values)`. */
export type WithChainMeta<TMeta, TValues> = InitAccMeta<TMeta> & { readonly [CHAIN_META]?: TValues }

/**
 * What a route under this handle must still pass to `.meta()`: the handle's meta with the keys chain
 * `.meta(values)` already supplied turned optional. A key no chain value sets stays as declared, so a required one
 * is still required: the chain's values are defaults, not a way to drop the declaration.
 */
export type ChainSupplied<TAccMeta> = [TAccMeta] extends [never]
	? {}
	: TAccMeta extends { readonly [CHAIN_META]?: infer TValues }
		? Omit<TAccMeta, keyof NonNullable<TValues>> &
				Partial<{ [K in keyof NonNullable<TValues>]: unknown } & RouteMeta<TAccMeta>>
		: RouteMeta<TAccMeta>

/** The meta type a handle declares (`meta<T>()`), chain values left out; `never` when none was declared. */
export type DeclaredMeta<TMeta> = [TMeta] extends [never]
	? never
	: [keyof RouteMeta<TMeta>] extends [never]
		? never
		: RouteMeta<TMeta>

/** Route meta as it is recorded: without the chain-meta key. */
export type RouteMeta<TAccMeta> = Omit<TAccMeta, typeof CHAIN_META>

/** Whether the meta marks the route internal (`internal: true`). */
type IsInternal<T> = [T] extends [{ internal: true }] ? true : false

/** A route whose meta, its own or its chain's, is `{ internal: true }` is left out of `$routes`. */
export type SkipRouteRecord<TAccMeta> = [TAccMeta] extends [never]
	? false
	: IsInternal<TAccMeta> extends true
		? true
		: TAccMeta extends { readonly [CHAIN_META]?: infer C }
			? IsInternal<NonNullable<C>>
			: false
