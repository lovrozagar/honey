/**
 * The document's security: the schemes the caller declares, and the check that every scheme an
 * operation's `security` names is among them. Naming an undeclared scheme is an error once schemes
 * are declared; with none declared at all it is only said, since the document may be partial.
 */
import { securitySchemeNames } from "../meta/meta-spec.ts"
import type { EmittedOperation } from "./paths.ts"

export type SecurityReport = (level: "error" | "warn", message: string) => void

/** Report each scheme an operation names that `schemes` does not declare. */
export function checkSecurity(
	operations: readonly EmittedOperation[],
	schemes: Readonly<Record<string, unknown>> | undefined,
	report: SecurityReport,
): void {
	const said = new Set<string>()
	for (const { method, operation, path } of operations) {
		for (const name of securitySchemeNames(operation.security)) {
			if (schemes !== undefined && Object.hasOwn(schemes, name)) continue
			const where = `${method.toUpperCase()} ${path}`
			if (schemes === undefined) {
				if (said.has(name)) continue
				said.add(name)
				report("warn", `security scheme "${name}" (first used by ${where}) is not declared — pass securitySchemes`)
			} else report("error", `${where}: security names "${name}", which is not in securitySchemes`)
		}
	}
}
