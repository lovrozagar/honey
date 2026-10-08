import type { RouteTree } from "@lovrozagar/honey/tree"

/**
 * Differential check: an app built from its generated route tree must answer every request
 * exactly like the same app building its trie at runtime — status, headers and body.
 */

export type Probe = { body?: string; headers?: Record<string, string>; method: string; path: string }

type Fetcher = { fetch(request: Request, env: never): Response | Promise<Response> }

/* request ids, timestamps and durations differ between any two requests */
const VOLATILE_HEADERS = new Set(["date", "server-timing", "x-request-id", "x-response-time"])
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

function concretePath(pattern: string): string {
	const out = pattern
		.split("/")
		.map((seg) => {
			if (seg.startsWith(":")) return "p1"
			if (seg.startsWith("*")) return "w1/w2"
			return seg
		})
		.join("/")
	return out === "" ? "/" : out
}

/**
 * Probes derived from a tree: every route with its own method, plus GET, HEAD, a CORS
 * preflight, a method the route lacks, and a path next to it that no route serves.
 */
export function probesFromTree(tree: RouteTree, mapPath: (path: string) => string = (p) => p): Probe[] {
	const probes: Probe[] = []
	for (const id of Object.keys(tree.routes)) {
		const sp = id.indexOf(" ")
		const method = id.slice(0, sp)
		if (method === "WS") continue
		const path = mapPath(concretePath(id.slice(sp + 1)))
		const json = { "content-type": "application/json" }
		if (method !== "ALL" && method !== "GET" && method !== "HEAD") {
			probes.push({ body: "{}", headers: json, method, path })
		}
		probes.push({ method: "GET", path })
		probes.push({ method: "HEAD", path })
		probes.push({ method: "PATCH", path, body: "{}", headers: json })
		probes.push({
			headers: { "access-control-request-method": "POST", origin: "http://client.test" },
			method: "OPTIONS",
			path,
		})
		probes.push({ method: "GET", path: mapPath(`${concretePath(id.slice(sp + 1))}/__nope__`) })
	}
	probes.push({ method: "GET", path: mapPath("/__nope__") })
	return probes
}

async function snapshot(app: Fetcher, probe: Probe): Promise<string> {
	let res: Response
	try {
		res = await app.fetch(
			new Request(`http://honey.test${probe.path}`, {
				body: probe.body,
				headers: probe.headers,
				method: probe.method,
			}),
			{} as never,
		)
	} catch (err) {
		return `threw ${(err as Error).message}`
	}
	const headers = [...res.headers]
		.filter(([k]) => !VOLATILE_HEADERS.has(k))
		.map(([k, v]) => `${k}: ${v.replace(UUID, "<uuid>")}`)
		.sort()
	const body = (await res.text()).replace(UUID, "<uuid>")
	return `${res.status}\n${headers.join("\n")}\n\n${body}`
}

/** Mismatches between the two apps, one line per probe that differs. */
export async function compareApps(runtime: Fetcher, fromTree: Fetcher, probes: Probe[]): Promise<string[]> {
	const out: string[] = []
	for (const probe of probes) {
		const [a, b] = await Promise.all([snapshot(runtime, probe), snapshot(fromTree, probe)])
		if (a !== b) out.push(`${probe.method} ${probe.path}\n--- runtime\n${a}\n--- route tree\n${b}`)
	}
	return out
}
