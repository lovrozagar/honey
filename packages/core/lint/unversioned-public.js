import { declaredNames } from "./public-declarations.js"
import { findPackageRoot, publicSurface } from "./public-surface.js"

/* A consumer reads a public name, not the history behind it: a `V2` left on one once a rewrite reached parity names a
 * version no consumer can pick. A wire format's version is data (a tree's `v`), so no public name carries one. */
const VERSIONED = /V\d+$/

const fix = (name) =>
	`drop the version: call it \`${name.replace(VERSIONED, "")}\`; a format's version is data, not a name`

export const rule = {
	create(context) {
		const root = findPackageRoot(context.filename)
		if (root === null) return {}
		const names = publicSurface(root).names.get(context.filename)
		return {
			ExportSpecifier(node) {
				const name = node.exported.name ?? node.exported.value
				const renamed = name !== (node.local.name ?? node.local.value)
				if (renamed && VERSIONED.test(name))
					context.report({ message: `\`${name}\` is exported under a version: ${fix(name)}`, node })
			},
			Program(program) {
				if (names === undefined) return
				for (const statement of program.body) {
					for (const name of declaredNames(statement)) {
						if (!names.has(name) || !VERSIONED.test(name)) continue
						const message = `\`${name}\` is public through "${names.get(name)}" and its name carries a version: ${fix(name)}`
						context.report({ message, node: statement })
					}
				}
			},
		}
	},
}

export default {
	meta: { name: "honey" },
	rules: { "unversioned-public": rule },
}
