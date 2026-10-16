//! The envelope's optional script (emit/shared/__fixtures__/protocol.ts `Script`), decoded strictly:
//! client config a grid Setup has no member for, scripted `on_auth_expired` tokens, recording hooks,
//! `on_log`, and per-call directives, the stream ones among them (`protocols`, `realtime`, `ws`). A
//! unit test or the harness sends one; the conformance runner never does. What only Go can do
//! (`ctxTimeoutMs`, `isKeys`, `isErrors`, `ws.readLimit`) is refused for good, before any call is sent.

use std::time::Duration;

use reqwest::header::{HeaderName, HeaderValue};
use serde::Deserialize;
use serde_json::Value;

use crate::trace::{self, Recorder};

/// The script.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Script {
    #[serde(default)]
    pub calls: Vec<Option<Directives>>,
    pub config: Option<ScriptConfig>,
    pub hooks: Option<ScriptHooks>,
    #[serde(default)]
    pub log: bool,
    #[serde(default)]
    pub log_durations: bool,
    pub on_auth_expired: Option<Tokens>,
}

/// The `ClientConfig` fields a grid Setup has no member for.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ScriptConfig {
    pub auth_header_name: Option<String>,
    pub auth_header_prefix: Option<String>,
    #[serde(default)]
    pub http_client: bool,
    pub invalidation: Option<Invalidation>,
    pub max_response_bytes: Option<usize>,
}

/// `InvalidationConfig`, its window in milliseconds.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Invalidation {
    #[serde(default)]
    pub max_sources_per_target: usize,
    #[serde(default)]
    pub stale_max_entries: usize,
    pub stale_time_ms: u64,
}

/// One hook per entry, in order; an absent list installs one recording no-op hook.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptHooks {
    pub request: Option<Vec<RequestHook>>,
    pub response: Option<Vec<ResponseHook>>,
}

/// An `on_request` hook: it sets a header, then fails when told to.
#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RequestHook {
    pub fail: Option<String>,
    pub set_header: Option<(String, String)>,
}

/// An `on_response` hook: it replaces the body, then fails when told to.
#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResponseHook {
    pub body: Option<String>,
    pub fail: Option<String>,
}

/// `on_auth_expired`'s answers: the i-th refresh returns `tokens[i]`, and fails past the end.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tokens {
    pub tokens: Vec<String>,
}

/// How a call is canceled: `"before"` it starts, or `{"afterMs": n}` into it.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cancel {
    Before,
    AfterMs(u64),
}

/// One call's script entry; the default directs nothing. Every member of the shared protocol is
/// listed, so strict decoding knows it and `refusal` can name it.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Directives {
    pub cancel: Option<Cancel>,
    pub ctx_timeout_ms: Option<Value>,
    #[serde(default)]
    pub envelope: bool,
    pub idempotency_key: Option<String>,
    pub is_errors: Option<Value>,
    pub is_keys: Option<Value>,
    #[serde(default)]
    pub one_shot_body: bool,
    pub protocols: Option<Vec<String>>,
    pub realtime: Option<RealtimeScript>,
    pub sleep_ms: Option<u64>,
    pub ws: Option<WsScript>,
}

/// The realtime Opts' reconnect fields a grid Call has no member for.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RealtimeScript {
    pub max_reconnect_attempts: Option<u32>,
    pub reconnect_delay_ms: Option<u64>,
}

/// A WebSocket past the grid's send and take: recording `on` handlers, more messages sent, and the
/// close the call ends with (1000 and no reason by default). `readLimit` is Go's alone.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WsScript {
    #[serde(default)]
    pub on: bool,
    #[serde(default)]
    pub send: Vec<WsMessage>,
    pub close: Option<Close>,
    pub read_limit: Option<Value>,
}

/// One scripted send: a JSON value (`send_json`), text (`send_text`), or that many bytes `i & 0xff`
/// (`send_binary`); exactly one of them.
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WsMessage {
    Json(Value),
    Text(String),
    Bytes(usize),
}

/// A close frame's code and reason.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Close {
    pub code: u16,
    pub reason: String,
}

impl Directives {
    /// What of the entry this driver refuses for good: what Go alone can do.
    fn refusal(&self) -> Option<String> {
        let go = [
            (
                self.ctx_timeout_ms.is_some(),
                "ctxTimeoutMs is Go's ctx deadline; a Rust call is bounded by timeoutMs",
            ),
            (
                self.is_keys.is_some(),
                "isKeys is Go's errors.Is; the Rust trace records key()",
            ),
            (
                self.is_errors.is_some(),
                "isErrors is Go's errors.Is; the Rust trace records the variant and text",
            ),
            (
                self.ws.as_ref().is_some_and(|ws| ws.read_limit.is_some()),
                "ws.readLimit is Go's SetReadLimit; a Rust socket caps a message at 16 MiB",
            ),
        ];
        let (_, reason) = go.iter().find(|(set, _)| *set)?;
        Some((*reason).into())
    }
}

impl Script {
    /// `raw` decoded strictly and checked for a cell of `calls` calls.
    pub fn parse(raw: &Value, calls: usize) -> Result<Script, String> {
        let script: Script = serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
        if script.calls.len() > calls {
            return Err(format!(
                "{} calls scripted for a cell of {calls}",
                script.calls.len()
            ));
        }
        for (i, d) in script.calls.iter().enumerate() {
            if let Some(reason) = d.as_ref().and_then(Directives::refusal) {
                return Err(format!("call {i}: {reason}"));
            }
        }
        if script.log_durations && !script.log {
            return Err("logDurations needs log".into());
        }
        Ok(script)
    }

    /// Call `i`'s entry; none without one.
    pub fn directives(&self, i: usize) -> Option<&Directives> {
        self.calls.get(i).and_then(Option::as_ref)
    }

    /// Sets the script's client config on `config` and installs its recorders: the hooks always (a
    /// no-op recording hook per phase whose list is absent), `on_auth_expired` and `on_log` when asked.
    pub fn apply(&self, config: &mut sdk::ClientConfig, rec: &Recorder) -> Result<(), String> {
        if let Some(c) = &self.config {
            c.apply(config);
        }
        if let Some(t) = &self.on_auth_expired {
            config.on_auth_expired = Some(trace::refresher(t.tokens.clone(), rec));
        }
        let hooks = self.hooks.as_ref();
        let request = hooks
            .and_then(|h| h.request.clone())
            .unwrap_or_else(|| vec![RequestHook::default()]);
        let response = hooks
            .and_then(|h| h.response.clone())
            .unwrap_or_else(|| vec![ResponseHook::default()]);
        for (i, entry) in request.into_iter().enumerate() {
            let header = header_of(&entry).map_err(|e| format!("hooks.request {i}: {e}"))?;
            config
                .on_request
                .push(trace::request_hook(i, entry.fail, header, rec));
        }
        for (i, entry) in response.into_iter().enumerate() {
            config.on_response.push(trace::response_hook(i, entry, rec));
        }
        if self.log {
            config.on_log = Some(trace::logger(self.log_durations, rec));
        }
        Ok(())
    }
}

/// A request hook's `setHeader`, parsed as the header it sets.
fn header_of(entry: &RequestHook) -> Result<Option<(HeaderName, HeaderValue)>, String> {
    let Some((name, value)) = &entry.set_header else {
        return Ok(None);
    };
    let name =
        HeaderName::from_bytes(name.as_bytes()).map_err(|e| format!("setHeader name: {e}"))?;
    let value = HeaderValue::from_str(value).map_err(|e| format!("setHeader value: {e}"))?;
    Ok(Some((name, value)))
}

impl ScriptConfig {
    /// Sets each given field on `config`. `httpClient` is a caller `http_builder`: its user agent is
    /// what a hop shows, since reqwest has no round-trip hook to count with.
    fn apply(&self, config: &mut sdk::ClientConfig) {
        if let Some(name) = &self.auth_header_name {
            config.auth_header_name = Some(name.clone());
        }
        if let Some(prefix) = &self.auth_header_prefix {
            config.auth_header_prefix = Some(prefix.clone());
        }
        if let Some(inv) = &self.invalidation {
            config.invalidation = Some(sdk::InvalidationConfig {
                stale_time: Duration::from_millis(inv.stale_time_ms),
                stale_max_entries: inv.stale_max_entries,
                max_sources_per_target: inv.max_sources_per_target,
            });
        }
        if let Some(max) = self.max_response_bytes {
            config.max_response_bytes = max;
        }
        if self.http_client {
            let builder = reqwest::Client::builder()
                .user_agent("honey-driver")
                .redirect(reqwest::redirect::Policy::limited(10));
            config.http_builder = Some(builder);
        }
    }
}
