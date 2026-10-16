//! The Rust SDK's test driver (bit 13, contract 18 §7.4, contract 19 §4.2): one program for the unit
//! behavior tests (emit/rust/*.test.ts against a recording server), the conformance runner and the
//! harness. The fixture builds it as a bin in a copy of the emitted crate (Fb6), so it uses the SDK as
//! `sdk` and only the SDK's own dependencies, with `dispatch.rs` written from the SDK's call plans.
//!
//! Stdin is one JSON object, the shared envelope:
//!
//!   { "cell": { "setup"?: Setup, "calls": Call[] }, "plans": { <operationId>: plan }, "base": url, "alt"?: url, "script"?: Script }
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
//! The driver refuses a stream operation and a call's `send`, `take`, `lastEventId` or
//! `reconnectToken` until phase d (`driver: <member> arrives in phase d`), and a multipart body for
//! good: its `FilePart`s have no JSON form, so a consumer program drives it.

/* one driver serves every SDK: a mode, a body kind or a member a given SDK lacks leaves its code unused */
#![allow(dead_code)]

mod apply;
mod dispatch;
mod observe;
mod protocol;
mod script;
mod sha256;
mod trace;

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use observe::Outcome;
use protocol::{Auth, Call, Input, Setup};
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
    /// outcome traced. Unscripted, an error the grid has no outcome for fails the run.
    async fn run(&self, i: usize, call: &Call, d: &Directives) -> Result<Value, String> {
        if let Some(ms) = d.sleep_ms {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        self.recorder.begin(i);
        let start = Instant::now();
        let outcome = perform(&self.client, call, self.input, d).await?;
        self.recorder.called(start.elapsed(), &outcome);
        match outcome {
            Outcome {
                observed: Some(seen),
                ..
            } => Ok(seen),
            Outcome { error: Some(e), .. } if !self.scripted => Err(format!(
                "the call ended in an error the grid has no outcome for: {}",
                e["text"].as_str().unwrap_or_default()
            )),
            _ => Ok(Value::Null),
        }
    }
}

/// Sends `call` by its plan, once the driver knows it can express it.
async fn perform(
    client: &sdk::Client,
    call: &Call,
    input: &Input,
    d: &Directives,
) -> Result<Outcome, String> {
    let Some(plan) = input.plans.get(&call.operation) else {
        return Err("no call plan names this operation".into());
    };
    if let Some(reason) = call.refusal() {
        return Err(reason);
    }
    if d.idempotency_key.is_some() && plan.idempotency_key.is_none() {
        return Err(
            "the script sets idempotencyKey, and the method has no idempotency key field".into(),
        );
    }
    if call.origin.as_deref() == Some("alt") && input.alt.is_none() {
        return Err("the call asks for the alt origin, and the input names none".into());
    }
    dispatch::dispatch(client, call, input, d).await
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
