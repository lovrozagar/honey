//! What a scripted run prints beside the observed (emit/shared/__fixtures__/protocol.ts
//! `Trace<RustError>`): each call's time, its error read through the SDK's accessors,
//! a safe call's `Answer` summary and a stream's trace; every hook run with what its context held; every
//! `on_log` entry; and the `on_auth_expired` calls. The SDK may call a hook off the call's task, so
//! the recorder is shared behind a mutex.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use reqwest::header::{HeaderName, HeaderValue};
use serde_json::{Map, Value, json};

use crate::observe::Outcome;
use crate::script::ResponseHook;

#[derive(Default)]
struct State {
    current: usize,
    calls: Vec<Value>,
    hooks: Vec<Value>,
    log: Vec<Value>,
    expired: usize,
}

/// A run's trace as it is recorded; a clone records into the same trace.
#[derive(Clone, Default)]
pub struct Recorder(Arc<Mutex<State>>);

impl Recorder {
    fn state(&self) -> MutexGuard<'_, State> {
        /* a hook that panicked while holding the lock left nothing half-written: each write is one push */
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Marks call `i` as the one hooks run for.
    pub fn begin(&self, i: usize) {
        self.state().current = i;
    }

    /// Records the call that just ended after `elapsed`.
    pub fn called(&self, elapsed: Duration, o: &Outcome) {
        let mut entry = Map::new();
        entry.insert("elapsedMs".into(), json!(elapsed.as_millis() as u64));
        if let Some(e) = &o.error {
            entry.insert("error".into(), e.clone());
        }
        if let Some(r) = &o.result {
            entry.insert("result".into(), r.clone());
        }
        if let Some(st) = &o.stream {
            entry.insert("stream".into(), st.clone());
        }
        self.state().calls.push(Value::Object(entry));
    }

    /// Records one hook run for the current call.
    fn hook(&self, mut entry: Map<String, Value>) {
        let mut state = self.state();
        entry.insert("call".into(), json!(state.current));
        state.hooks.push(Value::Object(entry));
    }

    /// The trace, every list present even when empty.
    pub fn trace(&self) -> Value {
        let state = self.state();
        json!({"authExpired": state.expired, "calls": state.calls, "hooks": state.hooks, "log": state.log})
    }
}

/// `e` as the trace records it: its variant (the leading identifier of its Debug), text, Debug, where
/// it came from, whether it has a source, its status, and an `Api` error's kind, key and message,
/// with its envelope when `envelope`.
pub fn rust_error(e: &sdk::Error, via: &str, envelope: bool) -> Value {
    let debug = format!("{e:?}");
    let variant: String = debug
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .collect();
    let mut out = Map::new();
    out.insert("variant".into(), json!(variant));
    out.insert("text".into(), json!(e.to_string()));
    out.insert("debug".into(), json!(debug));
    out.insert("via".into(), json!(via));
    out.insert(
        "source".into(),
        json!(std::error::Error::source(e).is_some()),
    );
    if let Some(status) = e.status() {
        out.insert("status".into(), json!(status));
    }
    if let sdk::Error::Api(api) = e {
        let key = api.key();
        out.insert("kind".into(), json!(format!("{:?}", api.kind())));
        out.insert("key".into(), json!(key.as_ref().map(ToString::to_string)));
        out.insert("keyVariant".into(), json!(format!("{key:?}")));
        out.insert("message".into(), json!(api.message()));
        if envelope {
            out.insert("envelope".into(), envelope_of(api.envelope()));
        }
    }
    Value::Object(out)
}

/// An envelope's members that are set, and its extra keys sorted.
fn envelope_of(env: &sdk::ErrorEnvelope) -> Value {
    let mut out = Map::new();
    if let Some(status) = env.status {
        out.insert("status".into(), json!(status));
    }
    for (name, text) in [
        ("error_key", &env.error_key),
        ("status_key", &env.status_key),
        ("message", &env.message),
    ] {
        if let Some(text) = text {
            out.insert(name.into(), json!(text));
        }
    }
    if !env.fields.is_empty() {
        let fields: Map<String, Value> = env
            .fields
            .iter()
            .map(|(name, errors)| {
                let errors: Vec<Value> = errors
                    .iter()
                    .map(
                        |f| json!({"error_key": f.error_key, "message": f.message, "path": f.path}),
                    )
                    .collect();
                (name.clone(), json!(errors))
            })
            .collect();
        out.insert("fields".into(), Value::Object(fields));
    }
    let mut extra: Vec<&String> = env.extra.keys().collect();
    extra.sort();
    out.insert("extraKeys".into(), json!(extra));
    Value::Object(out)
}

/// A safe call's `Answer`, once its response is proven its answer's (observe.rs): whether it is
/// `Ok`, and its status.
pub fn result_trace(ok: bool, status: u16) -> Value {
    json!({"data": ok, "ok": ok, "response": true, "status": status})
}

/// What every hook run records of its context: its phase, its index among that phase's hooks, and
/// the retry and stale fields (`selector`, `is_stale`, `invalidated_by`).
fn seen(
    phase: &str,
    index: usize,
    retry: bool,
    stale: (&str, bool, &[String]),
) -> Map<String, Value> {
    let (selector, is_stale, invalidated_by) = stale;
    let fields = [
        ("index", json!(index)),
        ("invalidatedBy", json!(invalidated_by)),
        ("isRetry", json!(retry)),
        ("isStale", json!(is_stale)),
        ("phase", json!(phase)),
        ("selector", json!(selector)),
    ];
    fields
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value))
        .collect()
}

/// `f` as an `on_request` hook (the bound makes the closure's signature higher-ranked).
fn on_request<F>(f: F) -> sdk::OnRequestHook
where
    F: for<'a> Fn(&'a mut sdk::RequestContext) -> sdk::HookFuture<'a> + Send + Sync + 'static,
{
    Arc::new(f)
}

/// `f` as an `on_response` hook.
fn on_response<F>(f: F) -> sdk::OnResponseHook
where
    F: for<'a> Fn(&'a mut sdk::ResponseContext) -> sdk::HookFuture<'a> + Send + Sync + 'static,
{
    Arc::new(f)
}

/// What a hook returns: `fail` ends the call as `Error::Hook` (Fc2).
fn outcome<'a>(fail: &Option<String>) -> sdk::HookFuture<'a> {
    let answer = match fail {
        Some(text) => Err(sdk::Error::Hook(text.clone().into())),
        None => Ok(()),
    };
    Box::pin(std::future::ready(answer))
}

/// The `index`-th request hook: it records what it saw, sets `header`, then fails with `fail`.
pub fn request_hook(
    index: usize,
    fail: Option<String>,
    header: Option<(HeaderName, HeaderValue)>,
    rec: &Recorder,
) -> sdk::OnRequestHook {
    let rec = rec.clone();
    on_request(move |ctx| {
        let mut entry = seen(
            "request",
            index,
            ctx.is_retry,
            (&ctx.selector, ctx.is_stale, &ctx.invalidated_by),
        );
        entry.insert("method".into(), json!(ctx.method.as_str()));
        entry.insert("url".into(), json!(ctx.url.to_string()));
        entry.insert("path".into(), json!(ctx.path));
        rec.hook(entry);
        if let Some((name, value)) = &header {
            ctx.headers.insert(name.clone(), value.clone());
        }
        outcome(&fail)
    })
}

/// The `index`-th response hook: it records what it saw, replaces the body, then fails.
pub fn response_hook(index: usize, hook: ResponseHook, rec: &Recorder) -> sdk::OnResponseHook {
    let rec = rec.clone();
    on_response(move |ctx| {
        let mut entry = seen(
            "response",
            index,
            ctx.is_retry,
            (&ctx.selector, ctx.is_stale, &ctx.invalidated_by),
        );
        entry.insert("status".into(), json!(ctx.status));
        rec.hook(entry);
        if let Some(body) = &hook.body {
            ctx.body = bytes::Bytes::from(body.clone());
        }
        outcome(&hook.fail)
    })
}

/// `on_auth_expired`, answering `tokens` in order, then failing as `Error::Config`.
pub fn refresher(tokens: Vec<String>, rec: &Recorder) -> sdk::OnAuthExpiredHook {
    let rec = rec.clone();
    Arc::new(move |_rejected| {
        let n = {
            let mut state = rec.state();
            state.expired += 1;
            state.expired
        };
        let answer = match tokens.get(n - 1) {
            Some(token) => Ok(Some(token.clone())),
            None => Err(sdk::Error::Config("driver: no token left".into())),
        };
        Box::pin(std::future::ready(answer))
    })
}

/// `on_log`, recording each entry, with its duration when `durations` (a duration is
/// nondeterministic, so a default trace stays exact).
pub fn logger(durations: bool, rec: &Recorder) -> sdk::OnLogHook {
    let rec = rec.clone();
    Arc::new(move |e: sdk::LogEntry| {
        let mut entry = Map::new();
        entry.insert("level".into(), json!(e.level));
        entry.insert("event".into(), json!(e.event));
        entry.insert("operation".into(), json!(e.operation));
        if let Some(status) = e.status {
            entry.insert("status".into(), json!(status));
        }
        if let Some(error) = e.error {
            entry.insert("error".into(), json!(error));
        }
        if durations {
            entry.insert("durationMs".into(), json!(e.duration_ms));
        }
        rec.state().log.push(Value::Object(entry));
    })
}
