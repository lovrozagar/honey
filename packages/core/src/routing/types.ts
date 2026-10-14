/** The HTTP methods a route registers for; `ALL` in a tree leaf answers any of them. */
export type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT"

/** A param name with its optional marker dropped: `id?` → `id`. */
type ParamKey<T extends string> = T extends `${infer Name}?` ? Name : T

/**
 * The param names of a route pattern, as a union: `/users/:id/posts/:postId` → `"id" | "postId"`.
 * An optional param counts under its name; a named wildcard under its name, an unnamed one as `"*"`.
 */
export type ParamKeys<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
	? ParamKey<Param> | ParamKeys<`/${Rest}`>
	: Path extends `${string}:${infer Param}`
		? ParamKey<Param>
		: Path extends `${string}*${infer Name}`
			? Name extends ""
				? "*"
				: Name
			: never

/** `ctx.params` for a route pattern; a pattern without params reads as a string record. */
export type ParamsFromPath<Path extends string> = [ParamKeys<Path>] extends [never]
	? Record<string, string>
	: { [K in ParamKeys<Path>]: string }

/** Join a base path and a route path at the type level; `/` is the identity on either side. */
export type MergePath<A extends string, B extends string> = A extends "/" ? B : B extends "/" ? A : `${A}${B}`

/** The routes of a mounted sub-app, moved under the mounting handle's base path. */
export type PrefixRoutes<TBase extends string, TRoutes> = TBase extends "/"
	? TRoutes
	: { [P in keyof TRoutes & string as MergePath<TBase, P>]: TRoutes[P] }
