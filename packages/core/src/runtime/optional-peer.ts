/**
 * An optional npm peer dependency, loaded the first time it is needed. `load` is the caller's own
 * literal `import("ws")`, so bundlers see the specifier; this is a plain dynamic import of a real
 * dependency, not a registry (H23). A missing peer fails with the package to install.
 */

/**
 * A loader for peer `name`: the first call imports it, later calls share that import. A failed
 * import is not remembered, so installing the peer later works without a restart.
 */
export function optionalPeer<T>(name: string, purpose: string, load: () => Promise<T>): () => Promise<T> {
	let loading: Promise<T> | null = null
	return () => {
		loading ??= load().catch((cause: unknown) => {
			loading = null
			throw new Error(
				`${purpose} need the "${name}" package, an optional peer dependency of honey. Install it: npm install ${name}`,
				{ cause },
			)
		})
		return loading
	}
}
