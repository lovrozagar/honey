/**
 * A Go module's path (plan 39 8.5), as the SDK and the CLI take it: refused unless `go mod init` would take it, and
 * given its major version suffix by a `version`. Go puts a v2-or-later module's major version at the end of its path
 * (`/v2`), and reads any last element `v` plus digits and dots as one, refusing it below v2, with a leading zero or
 * with a dot (module.SplitPathVersion). With a version, the path given is the base and the suffix is the version's,
 * so the two can never disagree.
 */
import { checked, SEMVER } from "../shared/metadata.ts"

/* a dotted domain, then path elements (Go's module.CheckPath, less its rarely used characters) */
const MODULE_PATH =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\/[A-Za-z0-9_~-](?:[A-Za-z0-9._~-]*[A-Za-z0-9_~-])?)*$/
/* a last element Go reads as a major version suffix, and the ones it takes */
const SUFFIX = /\/v[\d.]+$/
const MAJOR = /\/v(?:[2-9]|[1-9]\d+)$/

/** `modulePath` with the major suffix `version` gives from v2 on, each refused unless Go would take it. */
export function goModulePath(modulePath: string, version: string | undefined): string {
	checked("modulePath", modulePath, MODULE_PATH)
	const suffixed = SUFFIX.test(modulePath)
	if (suffixed && !MAJOR.test(modulePath))
		throw new Error(`Invalid modulePath: ${JSON.stringify(modulePath)}: Go's major suffix is /vN from v2, as /v2`)
	checked("version", version, SEMVER)
	if (version === undefined) return modulePath
	if (suffixed) throw new Error(`Invalid modulePath: ${JSON.stringify(modulePath)}: the version gives its major suffix`)
	const major = Number(version.split(".")[0])
	return major >= 2 ? `${modulePath}/v${major}` : modulePath
}
