/**
 * How a settings call retypes the handle or preset it returns (plan 39 7.1): the same setter on an app and on a preset
 * changes the same type parameter, and keeps every other. Type-only.
 */
import type { Honey } from "./app.ts"
import type { ScopedMwEntry } from "./app-types.ts"
import type { Preset } from "./preset.ts"

/** What a settings call changes in a handle's or a preset's type: `defaults` joins its default error keys, the rest replace. */
export type Retype = {
	/** The ctx routes start from. */
	readonly ctx?: unknown
	/** Error keys that join the default ones. */
	readonly defaults?: string
	/** The error factory's type. */
	readonly factory?: unknown
	/** The route meta type. */
	readonly meta?: unknown
	/** The declared tap payloads. */
	readonly taps?: Record<string, unknown>
}

/** The retype `errorFactory()` makes: the factory just set. */
export type SetFactory<TFactory> = {
	/** The factory just set. */
	readonly factory: TFactory
}

/** The retype `defaultErrors()` and `defaultBoundary()` make: the keys just declared join the default ones. */
export type AddDefaults<TKeys extends string> = {
	/** The keys just declared. */
	readonly defaults: TKeys
}

/** Slot `K` of `C`, else `T`. */
type Slot<C, K extends keyof Retype, T> = K extends keyof C ? C[K] : T

/** `H`, an app handle or a preset, with the slots `C` names changed and every other type parameter kept. */
export type Retyped<H, C extends Retype> =
	H extends Honey<
		infer TEnv,
		infer TCtx,
		infer TRoutes,
		infer TMeta,
		infer TFactory,
		infer TDefaults extends string,
		infer TBase extends string,
		infer TTaps extends Record<string, unknown>,
		infer TScoped extends readonly ScopedMwEntry[]
	>
		? Honey<
				TEnv,
				Slot<C, "ctx", TCtx>,
				TRoutes,
				Slot<C, "meta", TMeta>,
				Slot<C, "factory", TFactory>,
				TDefaults | (Slot<C, "defaults", never> & string),
				TBase,
				Extract<Slot<C, "taps", TTaps>, Record<string, unknown>>,
				TScoped
			>
		: H extends Preset<
					infer TEnv,
					infer TCtx,
					infer TMeta,
					infer TFactory,
					infer TDefaults extends string,
					infer TTaps extends Record<string, unknown>
			  >
			? Preset<
					TEnv,
					Slot<C, "ctx", TCtx>,
					Slot<C, "meta", TMeta>,
					Slot<C, "factory", TFactory>,
					TDefaults | (Slot<C, "defaults", never> & string),
					Extract<Slot<C, "taps", TTaps>, Record<string, unknown>>
				>
			: never

/** The keys of the error factory `H` was given; `never` before `errorFactory()`. */
export type FactoryKeys<H> = H extends { readonly $errorFactory: infer F }
	? [F] extends [never]
		? never
		: keyof F & string
	: never

/** `H` with route meta type `TMeta` declared; route meta may still carry its declared taps. */
export type WithMetaType<H, TMeta> = H extends { readonly $taps: infer TTaps }
	? Retyped<
			H,
			{
				/** The declared meta type, which may still carry the declared taps. */
				meta: [keyof TTaps] extends [never] ? TMeta : TMeta & Partial<TTaps>
			}
		>
	: never

/** `H` with tap payloads `TNewTaps` declared: they join its taps, and route meta may carry any of them. */
export type WithTaps<H, TNewTaps extends Record<string, unknown>> = H extends {
	readonly $meta: infer TMeta
	readonly $taps: infer TTaps
}
	? Retyped<
			H,
			{
				/** The meta type, which may now carry any declared tap. */
				meta: [TMeta] extends [never] ? Partial<TNewTaps> : TMeta & Partial<TNewTaps>
				/** The taps declared before and now. */
				taps: TTaps & TNewTaps
			}
		>
	: never
