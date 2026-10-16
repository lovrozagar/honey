//! The Rust SDK's test driver (bit 13, contract 18 §7.4): one program for the unit behavior tests
//! (emit/rust/*.test.ts against a recording server), the conformance runner and the harness. The
//! fixture builds it as a bin in a copy of the emitted crate (Fb6), so it uses the SDK as `sdk` and
//! only the SDK's own dependencies, with `dispatch.rs` written from the SDK's call plans.
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
//! Phase b refuses, each with `driver: <member> arrives in phase <x>`: a `script` (phase c), a binary
//! body or answer (phase c), and a stream operation or a call's `send`, `take`, `lastEventId` or
//! `reconnectToken` (phase d). Each refusal goes when its phase lands.

/* one driver serves every SDK: a mode, a body kind or a member a given SDK lacks leaves its code unused */
#![allow(dead_code)]

mod apply;
mod dispatch;
mod observe;
mod protocol;

use std::time::Duration;

use protocol::{Auth, Call, Input, Setup, refused};

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

/// Runs every call of the cell on stdin on one client: what each observed, as JSON.
async fn drive() -> Result<String, String> {
    let input: Input = serde_json::from_reader(std::io::stdin().lock())
        .map_err(|e| format!("read input: {e}"))?;
    if input.script.is_some() {
        return Err(refused("a script", "c"));
    }
    let client = client_of(&input)?;
    let mut observed = Vec::with_capacity(input.cell.calls.len());
    for (i, raw) in input.cell.calls.iter().enumerate() {
        let call: Call =
            serde_json::from_value(raw.clone()).map_err(|e| format!("call {i}: {e}"))?;
        let seen = perform(&client, &call, &input)
            .await
            .map_err(|e| format!("call {i} ({}): {e}", call.operation))?;
        observed.push(seen);
    }
    serde_json::to_string(&observed).map_err(|e| e.to_string())
}

/// Sends `call` by its plan, once the driver knows it can express it.
async fn perform(
    client: &sdk::Client,
    call: &Call,
    input: &Input,
) -> Result<serde_json::Value, String> {
    if !input.plans.contains_key(&call.operation) {
        return Err("no call plan names this operation".into());
    }
    if let Some(reason) = call.refusal() {
        return Err(reason);
    }
    if call.origin.as_deref() == Some("alt") && input.alt.is_none() {
        return Err("the call asks for the alt origin, and the input names none".into());
    }
    dispatch::dispatch(client, call, input).await
}

/// The client a cell's setup asks for, aimed at `base`.
fn client_of(input: &Input) -> Result<sdk::Client, String> {
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
        Some(other) => return Err(format!("setup: redirect {other:?} is not one the driver knows")),
    }
    if let Some(ms) = setup.timeout_ms {
        config.timeout = Some(Duration::from_millis(ms));
    }
    sdk::Client::new(config).map_err(|e| format!("client: {e}"))
}
