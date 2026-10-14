/**
 * `realtime(app, path, opts)`: a realtime route, built on `app.ws(path)` through the public API
 * alone. A plain function the app module imports (`@lovrozagar/honey/realtime`); nothing registers
 * itself (H23), and an app that never calls it bundles none of it.
 *
 * It returns the publisher for the route's namespace: REST handlers publish through it. The bus is
 * the isolation boundary: each call gets a fresh bus unless `opts.bus` is given, and routes share
 * topics only through the same bus and the same namespace. The default namespace is the `path`
 * given here, as written: a sub-app mounted twice runs one `realtime()` call, so both mounts share
 * its bus and namespace; call `realtime()` per mount to keep them apart.
 */
import type { MiddlewareFn, RuntimeMiddleware } from "../middleware/middleware.ts"
import type { Honey } from "../routing/app.ts"
import type { ApplyScoped, ScopedMwEntry } from "../routing/app-types.ts"
import type { MergePath } from "../routing/types.ts"
import type { WSRouteBuilder, WSRouteCtx } from "../routing/ws-builder.ts"
import { type RealtimeOptions, resolveRealtimeConfig } from "./route.ts"
import {
	createRealtimePublisher,
	createRealtimeSession,
	type RealtimePublisher,
	type RealtimeSession,
} from "./server.ts"

/** The ctx `app.ws(path)` hands its callbacks, which `identify` and `handler` receive. */
export type RealtimeCtx<TApp, TPath extends string> =
	TApp extends Honey<
		any,
		infer TCtx,
		any,
		any,
		any,
		any,
		infer TBase,
		any,
		infer TScoped extends readonly ScopedMwEntry[]
	>
		? WSRouteCtx<TCtx & ApplyScoped<TScoped, MergePath<TBase, TPath>>, MergePath<TBase, TPath>>
		: never

export function realtime<TApp extends Honey<any, any, any, any, any, any, any, any, any>, const TPath extends string>(
	app: TApp,
	path: TPath,
	options: RealtimeOptions<RealtimeCtx<TApp, TPath>>,
): RealtimePublisher {
	const config = resolveRealtimeConfig(path, options)
	const { identify } = config
	/* one session per upgrade request, keyed by its ctx: every ws callback receives that ctx */
	const sessions = new WeakMap<object, RealtimeSession>()
	/* after the route's middleware, before the origin check and the upgrade; a throw rejects the upgrade */
	const connect: RuntimeMiddleware = async (ctx, next) => {
		const userId = identify === null ? null : ((await identify(ctx)) ?? null)
		sessions.set(ctx, createRealtimeSession({ config, ctx, log: null, userId }))
		return next()
	}
	let route = app.ws(path) as WSRouteBuilder<unknown, string, unknown>
	for (const mw of [...config.use, connect]) route = route.use(mw as MiddlewareFn<unknown, unknown>)
	if (config.allowedOrigins !== null) route = route.origins(config.allowedOrigins)
	const session = (ctx: unknown) => sessions.get(ctx as object) as RealtimeSession
	route.handler({
		onClose: (ctx, _ws, _code, reason) => session(ctx).close(reason),
		onError: (ctx, _ws, error) => session(ctx).error(error),
		onMessage: (ctx, _ws, data) => session(ctx).message(data),
		onOpen: (ctx, ws) => session(ctx).attach(ws),
	})
	return createRealtimePublisher(config.bus, config.namespace)
}
