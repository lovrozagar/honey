/**
 * The official Python MCP client a leg drives the emitted server with (bit 21 b): `mcp` 2.3.0 pinned to 2026-07-28,
 * so it never falls back to initialize, its whole set pinned in `client-constraints.txt` (`uv pip compile` of
 * `mcp==2.3.0` under the pinned interpreter) and installed into a venv under the toolchain cache through python-env,
 * the one way gen runs Python: a test fixture only, never a dependency of gen. A session runs steps.ts's steps and
 * reports each as the TS clients (clients.ts) do. Bit 21 d: given a token, it runs over Streamable HTTP against the
 * server `--http` started, the token its bearer on an httpx2 client's headers.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { execPython, pinnedPython, pythonCacheDir, venv } from "../../python/__fixtures__/python-env.ts"
import { serving } from "./http-server.ts"
import type { Step, Stepped } from "./steps.ts"

/** The session script: connect pinned to 2026-07-28, run each step, report every step's outcome as one JSON line. */
const SESSION = `import json, os, sys
import anyio
import httpx2
from mcp import Client, StdioServerParameters
from mcp.client.streamable_http import streamable_http_client

def dumped(model):
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)

async def steps(server, out):
    async with Client(server, mode="2026-07-28") as client:
        for step in json.loads(sys.argv[2]):
            try:
                if step.get("negotiated"):
                    out.append({"negotiated": client.protocol_version})
                elif step.get("list"):
                    out.append({"tools": [dumped(tool) for tool in (await client.list_tools()).tools]})
                else:
                    out.append({"result": dumped(await client.call_tool(step["call"]["name"], step["call"]["arguments"]))})
            except Exception as error:
                out.append({"failed": str(error)})

async def main():
    target = json.loads(sys.argv[1])
    out = []
    if isinstance(target, list):
        await steps(StdioServerParameters(command=target[0], args=target[1:], env=dict(os.environ)), out)
    else:
        headers = {"Authorization": "Bearer " + target["token"]}
        async with httpx2.AsyncClient(headers=headers, timeout=httpx2.Timeout(30, read=300)) as http:
            await steps(streamable_http_client(target["url"], http_client=http), out)
    print(json.dumps(out))

anyio.run(main)
`

/** The client's venv: `mcp` and its whole set as `client-constraints.txt` pins them, made once per pin set. */
const clientVenv = (): string =>
	venv({
		constraints: new URL("./client-constraints.txt", import.meta.url).pathname,
		python: pinnedPython(),
		requirements: ["mcp"],
	})

/**
 * The Python client run against the server `command`, through `steps` in order: each step's outcome. Given a `token`,
 * the command serves `--http` and the session runs over Streamable HTTP with it as the bearer.
 */
export async function pythonSession(
	command: readonly string[],
	steps: readonly Step[],
	token?: string,
): Promise<readonly Stepped[]> {
	if (token === undefined) return session(command, steps)
	const server = await serving(command)
	try {
		return await session({ token, url: server.url }, steps)
	} finally {
		await server.stop()
	}
}

/** The session script against `target`: a command over stdio, or a URL and its token over HTTP. */
async function session(
	target: readonly string[] | { readonly url: string; readonly token: string },
	steps: readonly Step[],
) {
	/* one script per process: a concurrent writer in another worker never truncates the one this run reads */
	const path = join(pythonCacheDir("mcp-client"), `session-${process.pid}.py`)
	writeFileSync(path, SESSION)
	const ran = await execPython(clientVenv(), [path, JSON.stringify(target), JSON.stringify(steps)])
	if (ran.status !== 0) throw new Error(ran.stderr)
	return JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "[]") as readonly Stepped[]
}
