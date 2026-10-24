/** YAML read back to its value by Bun's own YAML parser: an oracle apart from the emitter. */
import { spawnSync } from "node:child_process"

export function yamlValue(text: string): unknown {
	const parsed = spawnSync(
		"bun",
		["-e", "console.log(JSON.stringify(Bun.YAML.parse(require('fs').readFileSync(0, 'utf8'))))"],
		{ encoding: "utf8", input: text },
	)
	return JSON.parse(parsed.stdout) as unknown
}
