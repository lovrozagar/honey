/**
 * The OAuth world (fixture.ts) as a process (bit 21 f), for a leg whose client runs outside core: gen's Python OAuth
 * leg starts it under Bun, as gen starts core's conformance app (F6), so gen imports nothing of core. `main()` prints
 * one readiness line (the endpoint, the issuer, the registered client and its redirect), and once its standard input
 * closes, one line with the log of every request answered, then stops.
 */
import { CLIENT_ID, REDIRECT_URI, startOAuthWorld } from "./fixture.ts"

export async function main(): Promise<void> {
	const world = await startOAuthWorld()
	const { endpoint, issuer } = world
	process.stdout.write(`${JSON.stringify({ clientId: CLIENT_ID, endpoint, issuer, redirectUri: REDIRECT_URI })}\n`)
	process.stdin.once("end", () => {
		process.stdout.write(`${JSON.stringify({ log: world.log })}\n`)
		void world.stop().finally(() => process.exit(0))
	})
	process.stdin.resume()
}
