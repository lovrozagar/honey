/**
 * `realtime(app, path, opts)`: a realtime route, built on `ws(app, path)` through the public API
 * alone. A plain function the app module imports (`@lovrozagar/honey/realtime`); nothing registers
 * itself (H23), and an app that never calls it bundles none of it.
 *
 * It returns the publisher for the route's namespace: REST handlers publish through it. The bus is
 * the isolation boundary: each call gets a fresh bus unless `opts.bus` is given, and routes share
 * topics only through the same bus and the same namespace. The default namespace is the `path`
 * given here, as written: a sub-app mounted twice runs one `realtime()` call, so both mounts share
 * its bus and namespace; call `realtime()` per mount to keep them apart.
 */
import { type HoneyContext, REQUEST } from "../context/context.ts"
import type { MiddlewareFn, RuntimeMiddleware } from "../middleware/middleware.ts"
import type { WSRouteBuilder, WSRouteCtx } from "../routing/ws-builder.ts"
import { type AnyHoneyHandle, ws, type WsRouteOf } from "../ws/route.ts"
import { type RealtimeOptions, resolveRealtimeConfig } from "./route.ts"
import {
	createRealtimePublisher,
	createRealtimeSession,
	type RealtimePublisher,
	type RealtimeSession,
} from "./server.ts"

/** The ctx `ws(app, path)` hands its callbacks, which `identify` and `handler` receive. */
export type RealtimeCtx<TApp, TPath extends string> =
	WsRouteOf<TApp, TPath> extends WSRouteBuilder<infer TCtx, infer TFull extends string, any>
		? WSRouteCtx<TCtx, TFull>
		: never

export function realtime<TApp extends AnyHoneyHandle, const TPath extends string>(
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
		sessions.set(
			ctx,
			createRealtimeSession({ config, ctx, log: (ctx as unknown as HoneyContext)[REQUEST].logger, userId }),
		)
		return next()
	}
	let route = ws(app, path) as WSRouteBuilder<unknown, string, unknown>
	for (const mw of [...config.use, connect]) route = route.use(mw as MiddlewareFn<unknown, unknown>)
	if (config.allowedOrigins !== null) route = route.origins(config.allowedOrigins)
	const session = (ctx: unknown) => sessions.get(ctx as object) as RealtimeSession
	route.handler({
		onClose: (ctx, _ws, _code, reason) => session(ctx).close(reason),
		onError: (ctx, _ws, error) => session(ctx).error(error),
		onMessage: (ctx, _ws, data) => session(ctx).message(data),
		onOpen: (ctx, socket) => session(ctx).attach(socket),
	})
	return createRealtimePublisher(config.bus, config.namespace)
}
