/**
 * What middleware added to a ctx. A prop is the framework's when every declaration of it is a
 * member of the framework's context class (the one declaring `res`), so the list never drifts from
 * the class; everything else, a user prop of a framework name included, was added. Each added prop
 * is written by the type its declaration names when there is one, else by its type.
 */
import type { ts } from "ts-morph"
import { isPublicName, type Serializer } from "./serialize.ts"
import type { Registration } from "./walk.ts"

export type ExtractedProp = { name: string; optional: boolean; type: string }

/** The class that declares `res` on `ctx`: the framework's context. None for a ctx typed without it. */
export function frameworkClass(ctx: ts.Type, compiler: typeof ts): ts.Node | undefined {
	const parent = ctx.getProperty("res")?.declarations?.[0]?.parent
	return parent !== undefined && compiler.isClassDeclaration(parent) ? parent : undefined
}

/**
 * The type an added prop's single declaration names: an annotation, the annotation of the variable
 * a shorthand (`next({ db })`) stands for, or, for a destructured variable (`const { db } = open()`),
 * the annotation of the variable the source's shorthand returns.
 */
function declaredRef(decl: ts.Declaration, ser: Serializer): string | undefined {
	const { checker, compiler } = ser
	if (!compiler.isShorthandPropertyAssignment(decl)) return ser.refFromDeclaration(decl)
	const variable = checker.getShorthandAssignmentValueSymbol(decl)?.valueDeclaration
	if (variable === undefined || !compiler.isBindingElement(variable)) return ser.refFromDeclaration(variable)
	/* `const { db } = open()`: the pattern's own declaration; a parameter or a nested pattern names nothing */
	const holder = variable.parent.parent
	const init = compiler.isVariableDeclaration(holder) ? holder.initializer : undefined
	const source = init === undefined ? undefined : checker.getTypeAtLocation(init).getProperty(decl.name.text)
	const returned = source?.valueDeclaration
	if (returned === undefined || !compiler.isShorthandPropertyAssignment(returned)) return undefined
	return ser.refFromDeclaration(checker.getShorthandAssignmentValueSymbol(returned)?.valueDeclaration)
}

/** The props of `ctx` the framework class does not own, in the ctx's order. */
export function addedProps(ctx: ts.Type, owner: ts.Node | undefined, ser: Serializer): ExtractedProp[] {
	const { checker, compiler } = ser
	/* a prop with no declaration (a mapped type's) is no member of anything */
	const owned = (decls: readonly ts.Declaration[]) =>
		owner !== undefined && decls.length > 0 && decls.every((d) => d.parent === owner)
	return ctx
		.getProperties()
		.filter((p) => isPublicName(p.getName()) && !owned(p.declarations ?? []))
		.map((p) => {
			const decls = p.declarations ?? []
			const optional = (p.flags & compiler.SymbolFlags.Optional) !== 0
			/* a prop several middleware add is their intersection: only the checker's type says it */
			const ref = decls.length === 1 ? declaredRef(decls[0] as ts.Declaration, ser) : undefined
			const type = checker.getTypeOfSymbol(p)
			return { name: p.getName(), optional, type: ref ?? (optional ? ser.optional(type) : ser.text(type)) }
		})
}

export type RouteOptions = {
	/** the names the app itself added: a route lists only what it adds beyond them */
	base: ReadonlySet<string>
	owner: ts.Node | undefined
	report: (message: string) => void
	routeId: (method: string, path: string) => string
}

const SKIPPED = "its ctx is not extracted"

/**
 * Each route's own additions by route id. A route whose path is no literal, or one the router
 * refuses, is skipped; an id two registrations give different additions is dropped, never guessed.
 */
export function routeAdditions(
	found: readonly Registration[],
	ser: Serializer,
	options: RouteOptions,
): Record<string, ExtractedProp[]> {
	const { base, owner, report, routeId } = options
	const byId = new Map<string, { props: ExtractedProp[]; key: string }>()
	const conflicted = new Set<string>()
	for (const { at, ctx, methods, path } of found) {
		if (path === null) {
			report(`${at}: the route's path is not a literal type; ${SKIPPED}`)
			continue
		}
		let ids: string[]
		try {
			ids = methods.map((method) => routeId(method, path))
		} catch (error) {
			report(`${at}: the router refuses ${JSON.stringify(path)} (${(error as Error).message}); ${SKIPPED}`)
			continue
		}
		const props = addedProps(ctx, owner, ser).filter((p) => !base.has(p.name))
		const key = JSON.stringify(props)
		for (const id of ids) {
			const seen = byId.get(id)
			if (seen === undefined) byId.set(id, { key, props })
			else if (seen.key !== key && !conflicted.has(id)) {
				conflicted.add(id)
				report(`${JSON.stringify(id)} is registered with different middleware; ${SKIPPED}`)
			}
		}
	}
	const out: Record<string, ExtractedProp[]> = {}
	for (const [id, { props }] of byId) if (props.length > 0 && !conflicted.has(id)) out[id] = props
	return out
}
