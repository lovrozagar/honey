/**
 * The test driver's `dispatch.rs` (contract 18 §7.4, R1): Rust has no reflection to find a method or an Opts
 * field by name, so the call plans write the code, one `match` arm per operation. An arm builds the
 * `<Op>Opts` from the call's query and header params, calls the method through its accessors with the path
 * params, the body and the opts in signature order, and observes the answer. Every type is inferred from the
 * method's parameters and the Opts fields, so a plan names no Rust type but the Opts. A safe-mode SDK
 * answers `SdkResult<T>`, which only the mode tells apart from a `T`, so it is observed by `observe_safe`.
 */
import type { RustCallPlan } from "../sdk-plan.ts"

const ARM = "        "
const BODY = "            "

/* each body kind's argument, decoded from the call's JSON body (a text body from a JSON string) */
const BODY_ARGUMENT: Readonly<Record<string, string>> = {
	form: "&call.json_body()?",
	json: "&call.json_body()?",
	multipart: "&call.json_body()?",
	text: "&call.text_body()?",
}

const literal = (text: string) => JSON.stringify(text)

/** What of `plan` the driver cannot call yet, and the phase that lands it; undefined when it can. */
function refusal(plan: RustCallPlan): readonly [what: string, phase: string] | undefined {
	if (plan.stream !== null) return ["a stream operation", "d"]
	if (plan.body === "binary") return ["a binary body", "c"]
	if (plan.response === "binary") return ["a binary answer", "c"]
	return undefined
}

/** The statement setting Opts field `field` from the call's `source` param `name`: a bare `T` when required. */
function setField(source: "header_param" | "search", name: string, field: string, plan: RustCallPlan): string {
	const value = plan.required.includes(field) ? "from(v)?" : "Some(from(v)?)"
	return `${BODY}if let Some(v) = call.${source}(${literal(name)}) { o.${field} = ${value}; }`
}

/** `plan`'s match arm, observing its answer with `observe`. */
function arm(plan: RustCallPlan, observe: string): string[] {
	const refused = refusal(plan)
	if (refused !== undefined)
		return [`${ARM}${literal(plan.operation)} => Err(refused(${literal(refused[0])}, ${literal(refused[1])})),`]
	const args = [
		...plan.pathParams.map((name) => `&call.param(${literal(name)})?`),
		...(plan.body === null ? [] : [BODY_ARGUMENT[plan.body] as string]),
		"&o",
	]
	const method = [...plan.accessors.map((accessor) => `${accessor}()`), `${plan.method}(${args.join(", ")})`]
	return [
		`${ARM}${literal(plan.operation)} => {`,
		`${BODY}let mut o = sdk::${plan.opts}::default();`,
		...Object.entries(plan.query).map(([name, field]) => setField("search", name, field, plan)),
		...Object.entries(plan.headers).map(([name, field]) => setField("header_param", name, field, plan)),
		...(plan.body === null ? [`${BODY}call.no_body()?;`] : []),
		`${BODY}let c = client.${method.join(".")};`,
		`${BODY}${observe}(apply(c, &call, &input)).await`,
		`${ARM}}`,
	]
}

/** `dispatch.rs` for `plans`, in operation order; `throwOnError: false` for a safe-mode SDK. */
export function dispatchRs(plans: Readonly<Record<string, RustCallPlan>>, throwOnError = true): string {
	const observe = throwOnError ? "observe" : "observe_safe"
	const arms = Object.values(plans)
		.sort((a, b) => (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0))
		.flatMap((plan) => arm(plan, observe))
	return [
		"// The driver's dispatch, written from the SDK's call plans by emit/rust/__fixtures__/dispatch.ts.",
		"#![allow(unused_imports, unused_mut)]",
		"",
		"use crate::apply::apply;",
		`use crate::observe::${observe};`,
		"use crate::protocol::{Call, Input, from, refused};",
		"",
		"/// Sends `call` on `client` by its operation's plan and returns what it observed.",
		"pub async fn dispatch(client: &sdk::Client, call: &Call, input: &Input) -> Result<serde_json::Value, String> {",
		"    match call.operation.as_str() {",
		...arms,
		'        other => Err(format!("no call plan names {other}")),',
		"    }",
		"}",
		"",
	].join("\n")
}
