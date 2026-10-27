/**
 * A preload (`node --import <this>`) that sends the process SIGTERM the moment `child_process.spawn` returns: the
 * window a loaded machine opens between a bin starting its Bun child and the bin's next statement (CI 40547426989).
 * A bin that registers its signal forwarders only after spawning dies there by SIGTERM's default action, its child
 * orphaned; one that registers them first forwards the signal once its event loop runs. Test-only.
 */
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"

const spawn = childProcess.spawn
childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
	const child = spawn(...args)
	process.kill(process.pid, "SIGTERM")
	return child
}) as typeof spawn
syncBuiltinESMExports()
