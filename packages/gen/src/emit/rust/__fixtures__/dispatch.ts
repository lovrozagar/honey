/**
 * The test driver's `dispatch.rs` (contract 18 §7.4, R1; contract 19 §4.2): Rust has no reflection to find a
 * method or an Opts field by name, so the call plans write the code, one `match` arm per operation. An arm
 * builds the `<Op>Opts` from the call's query and header params (and the script's idempotency key), calls the
 * method through its accessors with the path params, the body and the opts in signature order, and observes
 * the answer. Every type is inferred from the method's parameters and the Opts fields, so a plan names no Rust
 * type but the Opts and the `<Op>Headers` a typed-header arm reads through the real `FromHeaders`. A safe-mode
 * SDK answers `SdkResult<T>`, which only the mode tells apart from a `T`, so it is observed by `observe_safe`.
 *
 * A stream ignores the mode (contract 20 §4.2): an SSE arm reads through `stream.rs`, a WebSocket arm through
 * `socket.rs` and a realtime arm through `live.rs`, each setting the stream's own Opts fields (the resume
 * cursor from the call; the subprotocols and reconnect knobs from the script). `dispatch.rs` declares
 * `socket.rs` for any WebSocket or realtime plan and `live.rs` for any realtime plan (a `#[path]` resolves
 * beside it), so a crate without them never builds the code their SDK types would need.
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

/* each stream kind's own Opts lines, by the fixed field names the emitter gives them */
const LAST_EVENT_ID = `${BODY}o.last_event_id = call.last_event_id.clone();`
const RECONNECT_TOKEN = `${BODY}o.reconnect_token = call.reconnect_token.clone();`
const PROTOCOLS = `${BODY}if let Some(p) = &d.protocols { o.protocols = p.clone(); }`
const RECONNECT = `${BODY}if let Some(r) = &d.realtime { o.max_reconnect_attempts = r.max_reconnect_attempts; o.reconnect_delay_ms = r.reconnect_delay_ms; }`
const STREAM_OPTS: Readonly<Record<NonNullable<RustCallPlan["stream"]>, readonly string[]>> = {
	realtime: [LAST_EVENT_ID, RECONNECT_TOKEN, PROTOCOLS, RECONNECT],
	sse: [LAST_EVENT_ID],
	ws: [RECONNECT_TOKEN, PROTOCOLS],
}

/** How `plan`'s prepared call `prepared` is observed: by its stream's kind, else in the SDK's error mode. */
function observed(plan: RustCallPlan, prepared: string, observe: string): string {
	if (plan.stream === "sse") return `crate::stream::observe_events(${prepared}, call.take)`
	if (plan.stream === "ws") return `socket::observe_frames(${prepared}, call, d)`
	if (plan.stream === "realtime") return `live::observe_live(${prepared}, call)`
	return `${observe}(${prepared})`
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
	if (plan.body === "multipart") return [`${ARM}${literal(plan.operation)} => Err(${literal(MULTIPART)}.into()),`]
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
		...(plan.stream === null ? [] : STREAM_OPTS[plan.stream]),
		...(plan.body === null ? [`${BODY}call.no_body()?;`] : []),
		`${BODY}let c = client.${method.join(".")};`,
		...(plan.responseHeaders === null ? [] : reader(plan.responseHeaders)),
		`${BODY}${observed(plan, prepared, observe)}.await`,
		`${ARM}}`,
	]
}

/** The stream driver files `plans` need: `socket.rs` for a WebSocket or realtime plan, `live.rs` for a realtime one. */
function modules(plans: readonly RustCallPlan[]): string[] {
	const has = (...kinds: RustCallPlan["stream"][]) => plans.some((plan) => kinds.includes(plan.stream))
	return [
		...(has("ws", "realtime") ? ['#[path = "socket.rs"]', "mod socket;"] : []),
		...(has("realtime") ? ['#[path = "live.rs"]', "mod live;"] : []),
	]
}

/** `dispatch.rs` for `plans`, in operation order; `throwOnError: false` for a safe-mode SDK. */
export function dispatchRs(plans: Readonly<Record<string, RustCallPlan>>, throwOnError = true): string {
	const observe = throwOnError ? "observe" : "observe_safe"
	const sorted = Object.values(plans).sort((a, b) =>
		a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0,
	)
	const declared = modules(sorted)
	return [
		"// The driver's dispatch, written from the SDK's call plans by emit/rust/__fixtures__/dispatch.ts.",
		"#![allow(unused_imports, unused_mut)]",
		"",
		...(declared.length === 0 ? [] : [...declared, ""]),
		"use std::collections::BTreeMap;",
		"",
		"use crate::apply::apply;",
		`use crate::observe::{Outcome, ${observe}, put};`,
		"use crate::protocol::{Call, Input, from};",
		"use crate::script::Directives;",
		"",
		"/// Sends `call` on `client` by its operation's plan under the script's directives `d`, and returns its outcome.",
		"pub async fn dispatch(client: &sdk::Client, call: &Call, input: &Input, d: &Directives) -> Result<Outcome, String> {",
		"    match call.operation.as_str() {",
		...sorted.flatMap((plan) => arm(plan, observe)),
		'        other => Err(format!("no call plan names {other}")),',
		"    }",
		"}",
		"",
	].join("\n")
}
