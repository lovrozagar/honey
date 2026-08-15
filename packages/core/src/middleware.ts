/** phantom wrapper — at runtime it's just Response, carries TAdds for inference */
export type MiddlewareResult<TAdds = {}> = Response & {
	readonly __adds?: TAdds;
};

export type MiddlewareFn<
	TCtx = {},
	TAdds = {},
	TErrors extends string = string,
> = ((
	ctx: TCtx,
	next: {
		<T>(additions: T): Promise<MiddlewareResult<T>>;
		(): Promise<MiddlewareResult<{}>>;
	},
) => Promise<MiddlewareResult<TAdds>>) & {
	errors?: readonly TErrors[];
};

/** runtime type for stored middleware — erased generics, used internally */
export type RuntimeMiddleware = (
	ctx: Record<string, unknown>,
	next: (additions?: Record<string, unknown>) => Promise<Response>,
) => Promise<Response>;

/**
 * Create middleware with error keys constrained to a factory.
 * Error keys are stored on the function and auto-accumulated by .use().
 */
export function defineMiddleware<
	TReqs,
	TAdds,
	TFactory extends Record<string, (...args: never[]) => unknown>,
	TKeys extends keyof TFactory & string,
>(opts: {
	errors?: [TFactory, ...TKeys[]];
	fn: MiddlewareFn<TReqs, TAdds>;
}): MiddlewareFn<TReqs, TAdds, TKeys> {
	const fn = opts.fn as MiddlewareFn<TReqs, TAdds, TKeys>;
	if (opts.errors) {
		const [, ...keys] = opts.errors;
		Object.defineProperty(fn, "errors", { value: keys });
	}
	return fn;
}

type NextFn = {
	<T>(additions: T): Promise<MiddlewareResult<T>>;
	(): Promise<MiddlewareResult<{}>>;
};

/** Extract TAdds from callback return type — distributes over unions */
type ExtractAdds<T> = T extends Promise<MiddlewareResult<infer A>> ? A : never

/**
 * Middleware factory — annotate ctx for TReqs, TAdds inferred from return type:
 *   createMiddleware((ctx: { env: { DB: D1Database } }, next) => next({ db }))
 */
export function createMiddleware<TReqs = {}, TRet extends Promise<Response> = Promise<MiddlewareResult<{}>>>(
	fn: (ctx: TReqs, next: NextFn) => TRet,
): MiddlewareFn<TReqs, ExtractAdds<TRet>> {
	return fn as MiddlewareFn<TReqs, ExtractAdds<TRet>>
}

/**
 * Context properties that middleware additions must not overwrite.
 * These are set by the framework during request construction.
 * TypeScript prevents this at compile time; this guard catches runtime bypasses.
 */
const RESERVED_CTX_KEYS = new Set([
	"background",
	"cookies",
	"env",
	"headers",
	"params",
	"req",
	"res",
	"search",
]);

/**
 * Compile a middleware chain + handler into a single function at registration time.
 * Eliminates per-request recursive dispatch, closure allocation, and Promise.resolve wrapping.
 */
export function compileChain(
	middlewares: RuntimeMiddleware[],
	handler: (ctx: object) => Response | Promise<Response>,
): (ctx: object) => Response | Promise<Response> {
	if (middlewares.length === 0) {
		/* sync fast path — avoids microtask overhead for sync handlers */
		return (ctx) => {
			const result = handler(ctx);
			if (result instanceof Promise) {
				return result.then(validateResponse);
			}
			if (result === undefined || result === null) {
				throw new Error(
					"handler must return a Response — did you forget 'return ctx.res...()'?",
				);
			}
			return result;
		};
	}

	if (middlewares.length === 1) {
		const mw = middlewares[0];
		if (!mw) {
			throw new Error("middleware chain invariant violated");
		}
		return (ctx) => {
			const mwCtx = ctx as Record<string, unknown>;
			let called = false;
			return Promise.resolve(
				mw(mwCtx, (additions?: Record<string, unknown>) => {
					if (called) throw new Error("next() called multiple times");
					called = true;
					if (additions) mergeAdditions(ctx, additions);
					return Promise.resolve(handler(ctx)).then(validateResponse);
				}),
			).then(validateMiddlewareResponse);
		};
	}

	/* general case — pre-bind middleware array, no per-request index tracking */
	return (ctx) => executeChain(middlewares, ctx, handler);
}

function mergeAdditions(ctx: object, additions: Record<string, unknown>): void {
	for (const key in additions) {
		if (!RESERVED_CTX_KEYS.has(key)) {
			(ctx as Record<string, unknown>)[key] = additions[key];
		}
	}
}

function validateResponse(result: Response): Response {
	if (result === undefined || result === null) {
		throw new Error(
			"handler must return a Response — did you forget 'return ctx.res...()'?",
		);
	}
	return result;
}

function validateMiddlewareResponse(result: Response): Response {
	if (result === undefined || result === null) {
		throw new Error(
			"middleware must return a Response — did you forget 'return next(...)'?",
		);
	}
	return result;
}

export function executeChain(
	middlewares: RuntimeMiddleware[],
	ctx: object,
	handler: (ctx: object) => Response | Promise<Response>,
): Promise<Response> {
	let index = 0;
	/* middleware runtime type uses Record<string, unknown> — object satisfies at runtime */
	const mwCtx = ctx as Record<string, unknown>;

	function dispatch(): Promise<Response> {
		if (index >= middlewares.length) {
			return Promise.resolve(handler(ctx)).then((result) => {
				if (result === undefined || result === null) {
					throw new Error(
						"handler must return a Response — did you forget 'return ctx.res...()'?",
					);
				}
				return result;
			});
		}
		const mw = middlewares[index++];
		if (!mw) {
			throw new Error("middleware chain invariant violated");
		}
		let called = false;
		return Promise.resolve(
			mw(mwCtx, (additions?: Record<string, unknown>) => {
				if (called) {
					throw new Error("next() called multiple times");
				}
				called = true;
				if (additions) mergeAdditions(ctx, additions);
				return dispatch();
			}),
		).then((result) => {
			if (result === undefined || result === null) {
				throw new Error(
					"middleware must return a Response — did you forget 'return next(...)'?",
				);
			}
			return result;
		});
	}

	return dispatch();
}
