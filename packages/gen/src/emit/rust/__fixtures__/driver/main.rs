//! The Rust SDK's test driver (bit 13, contract 18 §7.4, contract 19 §4.2): one program for the unit
//! behavior tests (emit/rust/*.test.ts against a recording server), the conformance runner and the
//! harness. The fixture builds it as a bin in a copy of the emitted crate (Fb6), so it uses the SDK as
//! `sdk` and only the SDK's own dependencies, with `dispatch.rs` written from the SDK's call plans.
//!
//! Stdin is one JSON object, the shared envelope:
//!
//!   { "cell": { "setup"?: Setup, "calls": Call[] }, "plans": { <operationId>: plan }, "base": url, "alt"?: url,
//!     "drop"?: url, "refused"?: url, "script"?: Script }
//!
//! `cell` is the grid's Cell (its other members are ignored); `plans` are the emitter's call plans
//! (`rustCallPlans`). Every call of a cell runs in order on one client. Stdout is the grid's
//! `Observed[]` JSON, one per call. Any failure, and any Call or outcome this driver cannot express,
//! exits 1 with the reason on stderr: a red cell, never a silent pass.
//!
//! A `script` (script.rs; unit tests and the harness send one, the conformance runner never does)
//! sets what a grid Setup cannot, installs recording hooks and directs each call, and stdout becomes
//! `{ "observed": (Observed|null)[], "trace": Trace<RustError> }` (trace.rs): a call ending in an
//! error the grid has no Observed for observes null, its error traced. A bad script exits 1 before
//! any call is sent.
//!
//! A stream operation (stream.rs; socket.rs and live.rs, which dispatch.rs declares only for an SDK
//! that needs them) observes events (SSE) or frames (WebSocket, realtime), and a stream control its
//! operation cannot take is refused (`protocol::stream_refusal`). A stream call that has not ended
//! after 10 s fails the run ("stream stalled"). Unscripted, an error a stream yielded fails the run
//! like any error the grid has no outcome for. A multipart body is refused for good: its
//! `FilePart`s have no JSON form, so a consumer program drives it.

/* one driver serves every SDK: a mode, a body kind or a member a given SDK lacks leaves its code unused */
#![allow(dead_code)]

mod apply;
mod dispatch;
mod observe;
mod protocol;
mod script;
mod sha256;
mod stream;
mod trace;

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use observe::Outcome;
use protocol::{Auth, Call, Input, Setup, stream_refusal};
use script::{Directives, Script};
use trace::Recorder;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    match drive().await {
        Ok(observed) => println!("{observed}"),
        Err(reason) => {
            eprintln!("driver: {reason}");
            std::process::exit(1);
        }
    }
}

/// Runs every call of the cell on stdin on one client: what each observed, as JSON, beside the trace
/// under a script.
async fn drive() -> Result<String, String> {
    let input: Input =
        serde_json::from_reader(std::io::stdin().lock()).map_err(|e| format!("read input: {e}"))?;
    let script = match &input.script {
        None => None,
        Some(raw) => {
            Some(Script::parse(raw, input.cell.calls.len()).map_err(|e| format!("script: {e}"))?)
        }
    };
    let recorder = Recorder::default();
    let mut config = config_of(&input)?;
    config.on_response.push(observe::answered_status());
    if let Some(s) = &script {
        s.apply(&mut config, &recorder)
            .map_err(|e| format!("script: {e}"))?;
    }
    let client = sdk::Client::new(config).map_err(|e| format!("client: {e}"))?;
    let runner = Runner {
        client,
        input: &input,
        recorder,
        scripted: script.is_some(),
    };
    let none = Directives::default();
    let mut observed = Vec::with_capacity(input.cell.calls.len());
    for (i, raw) in input.cell.calls.iter().enumerate() {
        let call: Call =
            serde_json::from_value(raw.clone()).map_err(|e| format!("call {i}: {e}"))?;
        let d = script
            .as_ref()
            .and_then(|s| s.directives(i))
            .unwrap_or(&none);
        let seen = runner
            .run(i, &call, d)
            .await
            .map_err(|e| format!("call {i} ({}): {e}", call.operation))?;
        observed.push(seen);
    }
    let out = match script {
        None => json!(observed),
        Some(_) => json!({"observed": observed, "trace": runner.recorder.trace()}),
    };
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

/// What every call of a run shares.
struct Runner<'a> {
    client: sdk::Client,
    input: &'a Input,
    recorder: Recorder,
    scripted: bool,
}

impl Runner<'_> {
    /// Call `i` under its directives: a sleep before it, its time measured around the call alone, its
    /// outcome traced. Unscripted, an error the grid has no outcome for (one a stream yielded among
    /// them) fails the run.
    async fn run(&self, i: usize, call: &Call, d: &Directives) -> Result<Value, String> {
        if let Some(ms) = d.sleep_ms {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        self.recorder.begin(i);
        observe::forget_status();
        let start = Instant::now();
        let outcome = perform(&self.client, call, self.input, d).await?;
        self.recorder.called(start.elapsed(), &outcome);
        let ungraded = match (&outcome.error, &outcome.observed) {
            (Some(_), None) => !self.scripted,
            (Some(e), Some(seen)) if !self.scripted => {
                e["via"] == "stream"
                    && matches!(seen["kind"].as_str(), Some("events" | "frames"))
                    && seen.get("failed").is_none()
            }
            _ => false,
        };
        match outcome {
            Outcome { error: Some(e), .. } if ungraded => Err(format!(
                "the call ended in an error the grid has no outcome for: {}",
                e["text"].as_str().unwrap_or_default()
            )),
            Outcome {
                observed: Some(seen),
                ..
            } => Ok(seen),
            _ => Ok(Value::Null),
        }
    }
}

/// Sends `call` by its plan, once the driver knows it can express it; a stream call under
/// `STALL_AFTER`.
async fn perform(
    client: &sdk::Client,
    call: &Call,
    input: &Input,
    d: &Directives,
) -> Result<Outcome, String> {
    let Some(plan) = input.plans.get(&call.operation) else {
        return Err("no call plan names this operation".into());
    };
    if let Some(reason) = stream_refusal(call, plan, d) {
        return Err(reason);
    }
    if d.idempotency_key.is_some() && plan.idempotency_key.is_none() {
        return Err(
            "the script sets idempotencyKey, and the method has no idempotency key field".into(),
        );
    }
    if let (Some(origin), None) = (call.origin.as_deref(), apply::origin_of(call, input)) {
        return Err(format!(
            "the call asks for the {origin:?} origin, and the input names none"
        ));
    }
    let sent = dispatch::dispatch(client, call, input, d);
    if plan.stream.is_none() {
        return sent.await;
    }
    let bound = stream::STALL_AFTER;
    tokio::time::timeout(bound, sent)
        .await
        .map_err(|_| format!("stream stalled: no end within {}s", bound.as_secs()))?
}

/// The client config a cell's setup asks for, aimed at `base`.
fn config_of(input: &Input) -> Result<sdk::ClientConfig, String> {
    let setup: Setup = match &input.cell.setup {
        None => Setup::default(),
        Some(raw) => serde_json::from_value(raw.clone()).map_err(|e| format!("setup: {e}"))?,
    };
    let mut config = sdk::ClientConfig {
        base_url: input.base.clone(),
        ..Default::default()
    };
    config.headers.extend(setup.headers);
    match setup.auth {
        None => {}
        Some(Auth::Bearer { token }) => config.bearer_token = Some(token),
        Some(Auth::Header { name, value }) => {
            config.api_key = Some(value);
            config.auth_header_name = Some(name);
            config.auth_header_prefix = Some(String::new());
        }
    }
    match setup.redirect.as_deref() {
        None | Some("same-origin") => {}
        Some("follow") => config.redirect = sdk::RedirectPolicy::Follow,
        Some(other) => {
            return Err(format!(
                "setup: redirect {other:?} is not one the driver knows"
            ));
        }
    }
    if let Some(ms) = setup.timeout_ms {
        config.timeout = Some(Duration::from_millis(ms));
    }
    Ok(config)
}
