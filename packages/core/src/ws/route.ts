/**
 * `ws(app, path)`: a WebSocket route on `app`'s handle, `.handler({ onOpen, onMessage, onClose, … })`
 * registers it. A plain function the app module imports (`@lovrozagar/honey/ws`), not a `Honey`
 * method, so an app that never opens a socket bundles none of the route builder (H23).
 */
import type { Honey } from "../routing/app.ts"
import type { ApplyScoped, ScopedMwEntry } from "../routing/app-types.ts"
import { GRAPH, VIEW } from "../routing/register.ts"
import type { MergePath } from "../routing/types.ts"
import { startWsRoute, type WSRouteBuilder } from "../routing/ws-builder.ts"

/** Any app handle: a `honey()` app or a handle its `use()`, `basePath()`, `context()` or `meta()` returned. */
export type AnyHoneyHandle = Honey<any, any, any, any, any, any, any, any, any>

/** The builder `ws(app, path)` returns: the handle's ctx with the scopes over the route, at the joined path. */
export type WsRouteOf<TApp, TPath extends string> =
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
		? WSRouteBuilder<TCtx & ApplyScoped<TScoped, MergePath<TBase, TPath>>, MergePath<TBase, TPath>, TApp>
		: never

export function ws<TApp extends AnyHoneyHandle, const TPath extends string>(
	app: TApp,
	path: TPath,
): WsRouteOf<TApp, TPath> {
	return startWsRoute(app[GRAPH], app[VIEW], app, path) as WsRouteOf<TApp, TPath>
}
