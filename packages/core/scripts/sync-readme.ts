/* The npm package page shows packages/core/README.md. It is the root README with links rewritten
 * for that location (docs/ ships with the package, everything else points at GitHub) and the
 * maintainer-only release steps cut down. `bun run readme:sync` writes it; a unit test fails when
 * the committed copy drifts. */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO = "https://github.com/lovrozagar/honey"

const RELEASE_STEPS_START = "There is no `NPM_TOKEN` in repo secrets."
const RELEASE_STEPS_END = "GitHub Packages is the repo Packages sidebar, not the install path."
const RELEASE_STEPS_NPM =
	"Configure the trusted publisher once on this package (Settings → Trusted Publisher → GitHub Actions): repository `lovrozagar/honey`, workflow `release.yml`, no environment, allow npm publish. Do not put an npm token in GitHub secrets."

export function npmReadme(root: string): string {
	let out = root
		.replaceAll(
			"[packages/core/docs/meta-spec.md](packages/core/docs/meta-spec.md)",
			"[meta-spec.md](./docs/meta-spec.md)",
		)
		.replaceAll("[packages/core/docs/sdk.md](packages/core/docs/sdk.md)", "[SDK index](./docs/sdk.md)")
		.replaceAll(
			"[packages/core/examples](packages/core/examples)",
			`[examples](${REPO}/tree/main/packages/core/examples)`,
		)
		.replaceAll("](packages/core/docs/", "](./docs/")
		.replaceAll("](packages/core/", `](${REPO}/tree/main/packages/core/`)
		.replaceAll("](bench/", `](${REPO}/blob/main/bench/`)
		.replaceAll("](./.github/", `](${REPO}/blob/main/.github/`)
		.replaceAll(
			"(same as `packages/core/package.json` `version`) runs [",
			"(same as this `package.json` `version`) runs the repo [",
		)
	const start = out.indexOf(RELEASE_STEPS_START)
	const end = out.indexOf(RELEASE_STEPS_END)
	if (start !== -1 && end > start) {
		out = out.slice(0, start) + RELEASE_STEPS_NPM + out.slice(end + RELEASE_STEPS_END.length)
	}
	return out
}

export const ROOT_README = resolve(import.meta.dirname, "../../../README.md")
export const NPM_README = resolve(import.meta.dirname, "../README.md")

if (import.meta.main) {
	writeFileSync(NPM_README, npmReadme(readFileSync(ROOT_README, "utf-8")))
}
