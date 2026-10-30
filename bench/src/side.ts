/**
 * One side's honey, loaded from its own tree (bit 22 a1): the seam the A/B perf gate needs. A bench takes the honey it
 * exercises as a namespace rather than importing it, so the same harness — head's, always, since base cannot know a
 * scenario head adds — can build its app from head's `packages/core/src` and from a base worktree's.
 *
 * Two copies of the tree under different roots are two module graphs in one process: each side's `honey`, each side's
 * `HoneyError`, each side's everything is its own identity, and a relative import inside a side resolves inside that
 * side. `side.test.ts` asserts both, at several depths, rather than trusting it.
 *
 * The five gated benches import nothing but `packages/core/src` and node builtins, so a side is entirely that tree;
 * nothing is resolved from an install. A side is loaded once and shared by every scenario, as the one app per side is
 * today.
 */
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

/** The repository this harness belongs to: head, the side a bench always measures. */
export const HEAD_ROOT = /* @__PURE__ */ resolve(import.meta.dirname, "../..")

/* head's own modules, for the side's type: the shape is head's, whatever root a side is loaded from */
type App = typeof import("../../packages/core/src/routing/app.ts")
type Dispatch = typeof import("../../packages/core/src/routing/dispatch.ts")
type Middleware = typeof import("../../packages/core/src/middleware/middleware.ts")
type Cors = typeof import("../../packages/core/src/middleware/cors.ts")
type RequestId = typeof import("../../packages/core/src/middleware/request-id.ts")
type SecureHeaders = typeof import("../../packages/core/src/middleware/secure-headers.ts")

/**
 * The honey one side exports, the union of what the five benches reach for, plus the `root` it came from so a report
 * line and a failure can name the side. Every member is that side's own: never head's, unless the side is head.
 */
export type HoneySide = {
	readonly cors: Cors["cors"]
	readonly createMiddleware: Middleware["createMiddleware"]
	readonly finalTable: Dispatch["finalTable"]
	readonly GRAPH: App["GRAPH"]
	readonly honey: App["honey"]
	readonly requestId: RequestId["requestId"]
	readonly root: string
	readonly secureHeaders: SecureHeaders["secureHeaders"]
}

/** Where a side's modules live under its root. */
const SRC = "packages/core/src"

/**
 * The honey under `root`, loaded as its own module graph. Throws naming the root when it holds no honey tree, so a
 * mistyped base path fails at the load rather than measuring head against head.
 */
export async function sideOf(root: string): Promise<HoneySide> {
	const src = join(root, SRC)
	if (!existsSync(join(src, "routing/app.ts"))) throw new Error(`${root} holds no ${SRC}/routing/app.ts`)
	const [app, dispatch, middleware, cors, requestId, secureHeaders] = await Promise.all([
		import(join(src, "routing/app.ts")) as Promise<App>,
		import(join(src, "routing/dispatch.ts")) as Promise<Dispatch>,
		import(join(src, "middleware/middleware.ts")) as Promise<Middleware>,
		import(join(src, "middleware/cors.ts")) as Promise<Cors>,
		import(join(src, "middleware/request-id.ts")) as Promise<RequestId>,
		import(join(src, "middleware/secure-headers.ts")) as Promise<SecureHeaders>,
	])
	return {
		cors: cors.cors,
		createMiddleware: middleware.createMiddleware,
		finalTable: dispatch.finalTable,
		GRAPH: app.GRAPH,
		honey: app.honey,
		requestId: requestId.requestId,
		root,
		secureHeaders: secureHeaders.secureHeaders,
	}
}

/**
 * The base side's root for this run, from `PERF_BASE_DIR` (the worktree ci.yml checks out at the sha
 * blueprint/baselines/perf-base.json pins), or undefined when the run measures head alone — a local run, and every
 * run until phase b enforces.
 */
export function baseRootOf(env: Record<string, string | undefined>): string | undefined {
	const dir = env.PERF_BASE_DIR
	return dir === undefined || dir === "" ? undefined : resolve(dir)
}
