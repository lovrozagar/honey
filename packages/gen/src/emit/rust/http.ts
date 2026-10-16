/**
 * The vendored Rust runtime, as the files a Rust SDK ships (H9/F5): `runtime/rust/*.rs`, read here and
 * nowhere else, emitted verbatim under `src/`, and the `Cargo.lock` template the crate's lock is cut from.
 * The WebSocket file ships for a WebSocket or realtime API and the realtime files for a realtime API, so a
 * plain HTTP SDK carries neither them nor their dependency. The one reader is the F8 mutation target.
 */
import { readFileSync } from "node:fs"
import { compareCodeUnits } from "../shared/lang.ts"

/** What the API needs from the runtime beyond plain HTTP. */
export type RustRuntimeFeatures = { readonly realtime: boolean; readonly ws: boolean }

/* every SDK: config, the call, its request and exchange, redirects, auth, hooks, log, errors and their envelope, answers, SSE, invalidation */
const CORE: readonly string[] = [
	"answer",
	"auth",
	"body",
	"call",
	"config",
	"envelope",
	"errors",
	"events",
	"exchange",
	"hooks",
	"invalidation",
	"log",
	"nullable",
	"path",
	"query",
	"redirect",
	"request",
	"result",
	"sse",
	"stale",
]

/* a WebSocket operation; realtime adds the transports on top of it */
const WS: readonly string[] = ["ws"]
const REALTIME: readonly string[] = [
	"realtime",
	"realtime_loop",
	"transport",
	"transport_longpoll",
	"transport_sse",
	"transport_ws",
]

/* the lock template every crate's Cargo.lock is cut from */
const LOCK = "Cargo.lock"

/* a top-level public item: `pub struct Name`, `pub fn name`, … at column 0 */
const PUBLIC_ITEM = /^pub (?:struct|enum|trait|type|fn|const|static) ([A-Za-z_][A-Za-z0-9_]*)/gm

/** The runtime `.rs` file names an SDK with `features` ships, in code-unit order. */
export function runtimeFileNames(features: RustRuntimeFeatures): string[] {
	const names = [...CORE]
	if (needsWebSocket(features)) names.push(...WS)
	if (features.realtime) names.push(...REALTIME)
	return names.map((name) => `${name}.rs`).sort(compareCodeUnits)
}

/** Whether these features make the crate depend on `tokio-tungstenite` (Fb3). */
export const needsWebSocket = (features: RustRuntimeFeatures): boolean => features.ws || features.realtime

/** The runtime files an SDK with `features` ships, by file name, read verbatim, and the `Cargo.lock` template. */
export function runtimeFiles(features: RustRuntimeFeatures): Record<string, string> {
	return Object.fromEntries(
		[...runtimeFileNames(features), LOCK].map((name) => [
			name,
			readFileSync(new URL(`../../runtime/rust/${name}`, import.meta.url), "utf8"),
		]),
	)
}

/** The names of a Rust file's top-level public items (column 0), in source order: what the crate root exports. */
export function publicItems(source: string): string[] {
	return [...source.matchAll(PUBLIC_ITEM)].map((match) => match[1] as string)
}
