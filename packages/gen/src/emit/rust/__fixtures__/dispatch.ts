/**
 * The test driver's `dispatch.rs` (contract 18 §7.4, R1; contract 19 §4.2): Rust has no reflection to find a
 * method or an Opts field by name, so the call plans write the code, one `match` arm per operation. An arm
 * builds the `<Op>Opts` from the call's query and header params (and the script's idempotency key), calls the
 * method through its accessors with the path params, the body and the opts in signature order, and observes
 * the answer. Every type is inferred from the method's parameters and the Opts fields, so a plan names no Rust
 * type but the Opts and the `<Op>Headers` a typed-header arm reads through the real `FromHeaders`. A safe-mode
 * SDK answers `SdkResult<T>`, which only the mode tells apart from a `T`, so it is observed by `observe_safe`.
 */
import type { RustCallPlan } from "../sdk-plan.ts"

const ARM = "        "
const BODY = "            "

/* each body kind's argument: decoded from the call's JSON body (a text body from a JSON string), or bytes by value */
const BODY_ARGUMENT: Readonly<Record<string, string>> = {
	binary: "call.binary_body(d.one_shot_body)?",
	form: "&call.json_body()?",
	json: "&call.json_body()?",
	text: "&call.text_body()?",
}

/* a multipart body takes `FilePart`s, which have no JSON form: a consumer program drives it (contract 19 §1) */
const MULTIPART = "a multipart body is driven by a consumer program (FilePart)"

const literal = (text: string) => JSON.stringify(text)

/** `plan`'s arm when the driver cannot call it: a stream until phase d, a multipart body for good; undefined when it can. */
function refusal(plan: RustCallPlan): string | undefined {
	if (plan.stream !== null) return `Err(refused(${literal("a stream operation")}, ${literal("d")}))`
	if (plan.body === "multipart") return `Err(${literal(MULTIPART)}.into())`
	return undefined
}

/** The statement setting Opts field `field` from the call's `source` param `name`: a bare `T` when required. */
function setField(source: "header_param" | "search", name: string, field: string, plan: RustCallPlan): string {
	const value = plan.required.includes(field) ? "from(v)?" : "Some(from(v)?)"
	return `${BODY}if let Some(v) = call.${source}(${literal(name)}) { o.${field} = ${value}; }`
}

/** The `read` fn of a typed-header arm: the real `FromHeaders` impl, each field by its lower-case header name. */
function reader(headers: NonNullable<RustCallPlan["responseHeaders"]>): string[] {
	return [
		`${BODY}fn read(h: &reqwest::header::HeaderMap) -> Result<BTreeMap<String, String>, sdk::Error> {`,
		`${BODY}    let v = <sdk::${headers.type} as sdk::FromHeaders>::from_headers(h)?;`,
		`${BODY}    let mut m = BTreeMap::new();`,
		...Object.entries(headers.fields).map(
			([name, field]) => `${BODY}    put(&mut m, ${literal(name.toLowerCase())}, &v.${field});`,
		),
		`${BODY}    Ok(m)`,
		`${BODY}}`,
	]
}

/** `plan`'s match arm, observing its answer with `observe`. */
function arm(plan: RustCallPlan, observe: string): string[] {
	const refused = refusal(plan)
	if (refused !== undefined) return [`${ARM}${literal(plan.operation)} => ${refused},`]
	const args = [
		...plan.pathParams.map((name) => `&call.param(${literal(name)})?`),
		...(plan.body === null ? [] : [BODY_ARGUMENT[plan.body] as string]),
		"&o",
	]
	const method = [...plan.accessors.map((accessor) => `${accessor}()`), `${plan.method}(${args.join(", ")})`]
	const key = plan.idempotencyKey
	const prepared = plan.responseHeaders === null ? "apply(c, call, input, d)" : "apply(c, call, input, d).reading(read)"
	return [
		`${ARM}${literal(plan.operation)} => {`,
		`${BODY}let mut o = sdk::${plan.opts}::default();`,
		...Object.entries(plan.query).map(([name, field]) => setField("search", name, field, plan)),
		...Object.entries(plan.headers).map(([name, field]) => setField("header_param", name, field, plan)),
		...(key === null ? [] : [`${BODY}if let Some(k) = &d.idempotency_key { o.${key} = Some(k.clone()); }`]),
		...(plan.body === null ? [`${BODY}call.no_body()?;`] : []),
		`${BODY}let c = client.${method.join(".")};`,
		...(plan.responseHeaders === null ? [] : reader(plan.responseHeaders)),
		`${BODY}${observe}(${prepared}).await`,
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
		"use std::collections::BTreeMap;",
		"",
		"use crate::apply::apply;",
		`use crate::observe::{Outcome, ${observe}, put};`,
		"use crate::protocol::{Call, Input, from, refused};",
		"use crate::script::Directives;",
		"",
		"/// Sends `call` on `client` by its operation's plan under the script's directives `d`, and returns its outcome.",
		"pub async fn dispatch(client: &sdk::Client, call: &Call, input: &Input, d: &Directives) -> Result<Outcome, String> {",
		"    match call.operation.as_str() {",
		...arms,
		'        other => Err(format!("no call plan names {other}")),',
		"    }",
		"}",
		"",
	].join("\n")
}
