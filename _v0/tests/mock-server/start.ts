import { serve } from "../../src/node.ts"
import { createMockServer } from "./server.ts"

export async function startServer(port = 0): Promise<{ close: () => void; port: number }> {
	const app = createMockServer()
	const server = serve(app, { env: {}, port })
	const addr = server.address() as { port: number }
	return {
		close: () => {
			void server.shutdown(1000)
		},
		port: addr.port,
	}
}

if (import.meta.main) {
	const { port } = await startServer(0)
	process.stdout.write(`${JSON.stringify({ port })}\n`)

	process.on("SIGTERM", () => process.exit(0))
	process.on("SIGINT", () => process.exit(0))
}
