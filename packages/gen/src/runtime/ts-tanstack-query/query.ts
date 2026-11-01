/**
 * The TanStack Query adapter a TS SDK vendors (bit 22), emitted beside it as
 * `<stem>.tanstack-query.gen.ts` under `--ts-tanstack-query`. Read as text by `emit/ts/tanstack-query.ts`
 * and never imported by the generator, like every other `runtime/` module; its `../ts/*.ts` imports are
 * rewritten to the emitted runtime on the way out, so this file type-checks here and resolves there.
 *
 * Three surfaces over the service map, which is the authority for every question: `query` for the `GET`
 * entries, `mutation` for the rest, and `infiniteQuery` for a paged read. An entry that is an event stream,
 * a websocket or a realtime connection belongs to neither — a stream is not a cache entry — and asking for
 * one gives `undefined` rather than a factory that would key a stream as data.
 *
 * `@tanstack/query-core` is imported for types only: an emitted SDK is loaded from the consumer's own tree
 * (and, in this repository's tests, from outside it), so a value import would have to resolve at run time.
 * That is also why a read's options carry `initialData: undefined` — solid-query reads
 * `initialData?: Data | undefined` as the seeded overload, and the consumer that drives this is Solid.
 */
import type {
	DataTag,
	DefaultError,
	InfiniteData,
	InfiniteQueryObserverOptions,
	MutationObserverOptions,
	QueryClient,
	QueryKey,
	QueryObserverOptions,
} from "@tanstack/query-core"
import type { ServiceEntry, ServiceMap } from "../ts/sdk.ts"
import {
	childOf,
	indexReads,
	invalidatedBy,
	isEntry,
	isStream,
	keyOf,
	paramsOf,
	READ,
	type Read,
} from "./invalidate.ts"

/** The SDK, or a thunk for one: an isomorphic app builds a client per request. */
export type SdkSource<T> = T | (() => T)

/** What the helpers need beyond the SDK: the client whose cache a write invalidates. */
export type QueryHelperOptions = {
	getQueryClient?: (() => QueryClient) | undefined
}

/* an SDK method, whatever its shape: `unknown` collapses call signatures, which is what this must not do */
// oxlint-disable-next-line typescript/no-explicit-any
type AnyMethod = (...args: any[]) => any

type Req<M> = M extends (req: infer R, ...rest: never[]) => unknown ? R : never
type Init<M> = M extends (req: never, init: infer I, ...rest: never[]) => unknown ? I : never
type Data<M> = M extends (...args: never[]) => infer R ? Awaited<R> : never

/** `{ req }` is optional only when the request itself has no required field. */
type ReqOptions<M> = {} extends Req<M> ? { init?: Init<M>; req?: Req<M> } : { init?: Init<M>; req: Req<M> }

type ReadOptions<M> =
	{} extends Req<M>
		? { queryProps?: Omit<QueryObserverOptions<Data<M>>, "queryFn" | "queryKey">; reqOptions?: ReqOptions<M> }
		: { queryProps?: Omit<QueryObserverOptions<Data<M>>, "queryFn" | "queryKey">; reqOptions: ReqOptions<M> }

/** A read's options, keyed and seeded: `queryKey` is tagged so a cache read infers the answer. */
export type QueryFactory<M> = (
	...args: {} extends Req<M> ? [options?: ReadOptions<M>] : [options: ReadOptions<M>]
) => QueryObserverOptions<Data<M>, DefaultError, Data<M>, Data<M>, QueryKey> & {
	initialData: undefined
	queryKey: DataTag<QueryKey, Data<M>, DefaultError>
}

/** A write's options; `mutate` takes the SDK's own input, so a call site reads like the SDK call. */
export type MutationFactory<M> = (options?: {
	mutationProps?: Omit<MutationObserverOptions<Data<M>, DefaultError, Req<M>>, "mutationFn" | "mutationKey">
}) => MutationObserverOptions<Data<M>, DefaultError, Req<M>> & {
	mutationFn: (input: Req<M>) => Promise<Data<M>>
	mutationKey: QueryKey
}

/** A paged read: the caller says how a page param becomes a request and where the next one comes from. */
export type InfiniteFactory<M> = <TPageParam = number>(options: {
	buildReqOptions: (pageParam: TPageParam) => { init?: Init<M>; req: Req<M> }
	getNextPageParam: (
		lastPage: Data<M>,
		allPages: Data<M>[],
		lastPageParam: TPageParam,
		allPageParams: TPageParam[],
	) => TPageParam | null | undefined
	getPreviousPageParam?: (
		firstPage: Data<M>,
		allPages: Data<M>[],
		firstPageParam: TPageParam,
		allPageParams: TPageParam[],
	) => TPageParam | null | undefined
	infiniteQueryProps?: Omit<
		InfiniteQueryObserverOptions<Data<M>, DefaultError, InfiniteData<Data<M>>, QueryKey, TPageParam>,
		"getNextPageParam" | "getPreviousPageParam" | "initialPageParam" | "queryFn" | "queryKey"
	>
	initialPageParam: TPageParam
}) => InfiniteQueryObserverOptions<Data<M>, DefaultError, InfiniteData<Data<M>>, QueryKey, TPageParam>

/** A key builder: the request in, the key the matching factory would use out. */
export type KeyFactory<M> = (req?: Req<M>) => QueryKey

/**
 * One surface as this file can describe it: a tree of factories, indexable by name, callable at a leaf.
 * It cannot be more precise here — the map arrives as `ServiceMap`, whose literal types are gone, so which
 * names exist and what each one takes is not knowable at this layer. The emitted
 * `<stem>.tanstack-query.gen.ts` declares the exact nested types over its own document and this shape
 * disappears behind them; a consumer never sees it.
 */
export interface Surface {
	// oxlint-disable-next-line typescript/no-explicit-any
	(...args: any[]): any
	readonly [key: string]: Surface
}

function readSdk<T>(source: SdkSource<T>): T {
	return typeof source === "function" ? (source as () => T)() : source
}

/** The member path's method on the SDK, read when the call is made so a thunk stays per-call. */
function methodAt(sdk: unknown, member: readonly string[]): AnyMethod {
	let node: unknown = sdk
	for (const key of member) node = (node as Record<string, unknown>)[key]
	return node as AnyMethod
}

type Kind = "infiniteQuery" | "mutation" | "query" | "queryKey" | "mutationKey"

/** Which surface an entry belongs to; a stream belongs to none. */
function surfaceOf(entry: ServiceEntry, surface: Kind): boolean {
	if (isStream(entry)) return false
	const read = entry.method === READ
	return surface === "mutation" || surface === "mutationKey" ? !read : read
}

type Context = {
	getQueryClient?: (() => QueryClient) | undefined
	map: ServiceMap
	reads: Map<string, Read>
	sdk: SdkSource<unknown>
	sdkName: string
}

function queryOptionsAt(ctx: Context, member: string[], entry: ServiceEntry) {
	return (options?: { queryProps?: object; reqOptions?: { init?: unknown; req?: unknown } }) => {
		const { init, req } = options?.reqOptions ?? {}
		const args = init === undefined ? [req] : [req, init]
		return {
			queryFn: () => methodAt(readSdk(ctx.sdk), member)(...args),
			queryKey: keyOf(ctx.sdkName, { member, params: entry.params ?? [] }, paramsOf(req)),
			...options?.queryProps,
			/* after the spread: a caller's queryProps cannot un-seed the Solid overload */
			initialData: undefined,
		}
	}
}

function mutationOptionsAt(ctx: Context, member: string[], entry: ServiceEntry) {
	return (options?: { mutationProps?: object }) => ({
		mutationFn: async (input: unknown) => {
			const data = await methodAt(readSdk(ctx.sdk), member)(input)
			const client = ctx.getQueryClient?.()
			if (client !== undefined) {
				const keys = invalidatedBy(ctx.reads, ctx.sdkName, entry, input)
				await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })))
			}
			return data
		},
		mutationKey: [ctx.sdkName, ...member],
		...options?.mutationProps,
	})
}

function infiniteOptionsAt(ctx: Context, member: string[], entry: ServiceEntry) {
	return (options: {
		buildReqOptions: (pageParam: unknown) => { init?: unknown; req: unknown }
		infiniteQueryProps?: object
		initialPageParam: unknown
	}) => {
		const { buildReqOptions, infiniteQueryProps, initialPageParam, ...rest } = options
		return {
			...rest,
			initialPageParam,
			queryFn: (context: { pageParam: unknown }) => {
				const { init, req } = buildReqOptions(context.pageParam)
				const args = init === undefined ? [req] : [req, init]
				return methodAt(readSdk(ctx.sdk), member)(...args)
			},
			queryKey: keyOf(
				ctx.sdkName,
				{ member, params: entry.params ?? [] },
				paramsOf(buildReqOptions(initialPageParam).req),
			),
			...infiniteQueryProps,
		}
	}
}

function keyFactoryAt(ctx: Context, member: string[], entry: ServiceEntry) {
	return (req?: unknown) => keyOf(ctx.sdkName, { member, params: entry.params ?? [] }, paramsOf(req))
}

function factoryFor(ctx: Context, surface: Kind, member: string[], entry: ServiceEntry): unknown {
	if (surface === "query") return queryOptionsAt(ctx, member, entry)
	if (surface === "mutation") return mutationOptionsAt(ctx, member, entry)
	if (surface === "infiniteQuery") return infiniteOptionsAt(ctx, member, entry)
	return keyFactoryAt(ctx, member, entry)
}

/**
 * One surface as a proxy over the map: a branch gives a branch, an operation of that surface gives its
 * factory, and anything else — a write on `query`, a read on `mutation`, a stream on either, a name the
 * map does not hold — gives `undefined`, so the surface never invents an operation.
 */
function surfaceProxy(ctx: Context, surface: Kind, node: ServiceMap, member: string[]): unknown {
	return new Proxy(Object.create(null) as object, {
		get(_, key) {
			if (typeof key !== "string") return undefined
			const child = childOf(node, key)
			if (child === undefined) return undefined
			const at = [...member, key]
			if (!isEntry(child)) return surfaceProxy(ctx, surface, child as ServiceMap, at)
			return surfaceOf(child, surface) ? factoryFor(ctx, surface, at, child) : undefined
		},
		has(_, key) {
			return typeof key === "string" && childOf(node, key) !== undefined
		},
	})
}

/**
 * The helper set for `sdk` over `map`. `sdkName` heads every key, so two SDKs in one cache never collide.
 * The emitted wrapper passes its own map and name and types each surface from the document, the way the
 * generated client passes its map to `SDKClient`.
 */
export function queryHelpers<TSDK>(
	sdk: SdkSource<TSDK>,
	map: ServiceMap,
	sdkName: string,
	options: QueryHelperOptions = {},
): {
	infiniteQuery: Surface
	mutation: Surface
	mutationKey: Surface
	query: Surface
	queryKey: Surface
} {
	const ctx: Context = {
		getQueryClient: options.getQueryClient,
		map,
		reads: indexReads(map),
		sdk,
		sdkName,
	}
	const of = (surface: Kind) => surfaceProxy(ctx, surface, map, []) as Surface
	return {
		infiniteQuery: of("infiniteQuery"),
		mutation: of("mutation"),
		mutationKey: of("mutationKey"),
		query: of("query"),
		queryKey: of("queryKey"),
	}
}
