/**
 * One command per operation (bit 17), by its dotted id: `items.get` is `items get`, `a.b.c` is `a b c`, a flat id
 * (`getRoot`) a top-level `get-root`. The verb is the id's last segment as authored, never renamed. In a group a
 * subgroup claims its name before a command, and at the root every built-in (completion, commands, config, help,
 * schema, skill, version) is taken first, so a clash is suffixed as the IR suffixes ids (`version2`). Each command calls
 * the embedded SDK's own method by the emitter's call plan, its body read from its flags (a multipart one part by
 * part), and prints the answer with the response it came on. Streams join at phase d.
 */
import type { IR } from "../../ir/model.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import type { GoCallPlan } from "../go/sdk-client.ts"
import { goString, lineComment } from "../shared/escape.ts"
import { compareCodeUnits, NameScope, pascalWords } from "../shared/lang.ts"
import { type CommandFlags, commandFlags, helpText, kebab, type PartFlag } from "./flags.ts"

/** The root's own commands, each taken before an operation's. */
export const BUILT_INS = ["commands", "completion", "config", "help", "schema", "skill", "version"]

/** A command node: a group of others, or one operation's command. */
export type CommandNode = {
	readonly name: string
	readonly fn: string
	readonly children: readonly CommandNode[]
	readonly op?: { readonly op: SdkOp; readonly plan: GoCallPlan }
}

/** Whether `op` has a command yet: it answers once (streams join at phase d). */
export const commanded = (op: SdkOp): boolean => op.stream === null

/** The raw tree: each segment's subtree, and the operation a path ends at. */
type Raw = { readonly groups: Map<string, Raw>; readonly leaves: Map<string, { op: SdkOp; plan: GoCallPlan }> }

function rawTree(ops: readonly SdkOp[], plans: Readonly<Record<string, GoCallPlan>>): Raw {
	const root: Raw = { groups: new Map(), leaves: new Map() }
	for (const op of [...ops].filter(commanded).sort((a, b) => compareCodeUnits(a.id, b.id))) {
		let at = root
		for (const segment of op.segments.slice(0, -1)) {
			if (!at.groups.has(segment)) at.groups.set(segment, { groups: new Map(), leaves: new Map() })
			at = at.groups.get(segment) as Raw
		}
		at.leaves.set(op.segments.at(-1) as string, { op, plan: plans[op.id] as GoCallPlan })
	}
	return root
}

/** `raw` named: its groups first, then its commands, each claimed in its parent's scope; funcs claimed in `funcs`. */
function named(raw: Raw, path: readonly string[], scope: NameScope, funcs: NameScope): CommandNode[] {
	const groups = [...raw.groups].sort(([a], [b]) => compareCodeUnits(a, b))
	const leaves = [...raw.leaves].sort(([a], [b]) => compareCodeUnits(a, b))
	return [
		...groups.map(([segment, child]): CommandNode => {
			const name = scope.claim(kebab(segment))
			const at = [...path, name]
			return {
				children: named(child, at, new NameScope(), funcs),
				fn: funcs.claim(`new${pascalWords(at.join(" "))}Cmd`),
				name,
			}
		}),
		...leaves.map(([segment, leaf]): CommandNode => {
			const name = scope.claim(kebab(segment))
			return { children: [], fn: funcs.claim(`new${pascalWords([...path, name].join(" "))}Cmd`), name, op: leaf }
		}),
	]
}

/** The command tree under the root, by the ids of every operation `ops` holds a command for. */
export function commandTree(ops: readonly SdkOp[], plans: Readonly<Record<string, GoCallPlan>>): CommandNode[] {
	return named(rawTree(ops, plans), [], new NameScope(BUILT_INS), new NameScope(["Root", "newClient", "failed"]))
}

/** A named type of the SDK's, as package cmd spells it: `sdk.` before each exported name. */
const qualified = (type: string) => type.replace(/(?<![\w.])([A-Z]\w*)/g, "sdk.$1")

/** A multipart body's statements: each file part from its opened files, each text part from its flag. */
function multipartLines(type: string, parts: readonly PartFlag[]): string[] {
	const lines = [`\tvar body ${type}`]
	for (const [i, part] of parts.entries()) {
		if (!part.file) {
			lines.push(
				`\tif err := cli.Set(&body.${part.field}, p.Values(${goString(part.flag)})); err != nil {`,
				"\t\treturn err",
				"\t}",
			)
			continue
		}
		const file = "sdk.FilePart{Filename: upload.Filename, Data: upload.Data}"
		const set = part.list ? `body.${part.field} = append(body.${part.field}, ${file})` : `body.${part.field} = ${file}`
		lines.push(
			`\tuploads${i}, err := p.Files(${goString(part.flag)})`,
			"\tif err != nil {",
			"\t\treturn err",
			"\t}",
			`\tfor _, upload := range uploads${i} {`,
			`\t\t${set}`,
			"\t}",
		)
	}
	return lines
}

/** The statements reading the body, and the argument passing it. */
function bodyLines(op: SdkOp, plan: GoCallPlan, flags: CommandFlags): [string[], string] {
	const { fields } = flags
	const body = op.body
	if (body === undefined) return [[], ""]
	const required = String(body.required)
	const map = `map[string]string{${fields.map(([flag, key]) => `${goString(flag)}: ${goString(key)}`).join(", ")}}`
	const fail = ["\tif err != nil {", "\t\treturn err", "\t}"]
	switch (body.kind) {
		case "json": {
			/* a pointer type decodes as well: json.Unmarshal allocates it, and an absent optional body stays nil */
			const read = `\tif err := p.JSON(&body, ${required}, ${map}); err != nil {`
			return [[`\tvar body ${qualified(plan.bodyType as string)}`, read, "\t\treturn err", "\t}"], ", body"]
		}
		case "form":
			return [[`\tbody, err := p.Form(${required}, ${map})`, ...fail], ", body"]
		case "text":
			return [[`\tbody, err := p.Text(${required})`, ...fail], ", body"]
		case "multipart":
			return [multipartLines(qualified(plan.bodyType as string), flags.parts), ", body"]
		default:
			return [[`\tbody, err := p.Reader(${required})`, ...fail], ", body"]
	}
}

/** The call and what follows it, by what the method returns: the answer printed with the response it came on. */
function callLines(call: string, plan: GoCallPlan): string[] {
	const declared = Object.keys(plan.responseHeaders?.fields ?? {})
		.map(goString)
		.join(", ")
	const answer = (data: string) =>
		`\treturn cli.Print(c, cli.Answer{${data}Response: resp, Declared: []string{${declared}}})`
	if (plan.returns === "error")
		return [
			"\tvar resp *http.Response",
			`\tif err := ${call}; err != nil {`,
			"\t\treturn failed(err)",
			"\t}",
			answer(""),
		]
	return [
		"\tvar resp *http.Response",
		`\tanswer, err := ${call}`,
		"\tif err != nil {",
		"\t\treturn failed(err)",
		"\t}",
		answer("Data: answer, "),
	]
}

/** An operation's command function: its flags, then the RunE that checks them, calls the SDK and prints. */
function opFunc(node: CommandNode, path: readonly string[], ir: IR): string[] {
	const { op, plan } = node.op as { op: SdkOp; plan: GoCallPlan }
	const flags = commandFlags(op, plan, ir.schemas)
	const use = [node.name, ...plan.pathParams.map((name) => `<${kebab(name)}>`)].join(" ")
	const [read, bodyArg] = bodyLines(op, plan, flags)
	const args = plan.pathParams.map((_, i) => `, path[${i}]`).join("")
	const method = ["client", ...plan.members, plan.method].join(".")
	const cobra = [`Use: ${goString(use)}`, `Short: ${goString(helpText(op.summary))}`]
	if (op.description !== "") cobra.push(`Long: ${goString(helpText(op.description))}`)
	const run = [
		"\tif err := p.Check(); err != nil {",
		"\t\treturn err",
		"\t}",
		...(plan.pathParams.length > 0 ? ["\tpath := p.PathValues(args)"] : []),
		`\topts := &sdk.${plan.opts}{}`,
		...flags.opts,
		...read,
		"\tclient, err := newClient(c)",
		"\tif err != nil {",
		"\t\treturn err",
		"\t}",
		...callLines(`${method}(c.Context()${args}${bodyArg}, opts, sdk.WithResponseInto(&resp))`, plan),
	]
	return [
		...lineComment(`${node.fn} is \`${[...path, node.name].join(" ")}\`: ${op.method} ${op.path}.`, "//"),
		`func ${node.fn}() *cobra.Command {`,
		`\tcmd := &cobra.Command{${cobra.join(", ")}}`,
		"\tp := cli.NewParams(cmd)",
		...flags.declare,
		`\tcmd.RunE = func(c *cobra.Command, ${plan.pathParams.length > 0 ? "args" : "_"} []string) error {`,
		...run.map((line) => `\t${line}`),
		"\t}",
		"\treturn cmd",
		"}",
	]
}

/** A group's command function, then each of its children's. */
export function groupFuncs(node: CommandNode, path: readonly string[], ir: IR): string[][] {
	if (node.op !== undefined) return [opFunc(node, path, ir)]
	const at = [...path, node.name]
	const children = node.children.map((child) => `${child.fn}()`).join(", ")
	const own = [
		...lineComment(`${node.fn} is \`${at.join(" ")}\`, a group of commands.`, "//"),
		`func ${node.fn}() *cobra.Command {`,
		`\tcmd := cli.Group(&cobra.Command{Use: ${goString(node.name)}})`,
		`\tcmd.AddCommand(${children})`,
		"\treturn cmd",
		"}",
	]
	return [own, ...node.children.flatMap((child) => groupFuncs(child, at, ir))]
}
