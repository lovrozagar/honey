//! A call's outcome as the grid observes it, read through `.with_response()` and the SDK's accessors:
//! the data and the status (with the typed response headers when the plan declares them); a binary
//! answer's size and SHA-256; the raw response for `raw: true`; an error status as `error` with its
//! body and honey error key (`ApiError::key()`); a lapsed timeout as `timeout`. Every error is also
//! traced (`trace::rust_error`); one the grid has no outcome for observes nothing, which fails an
//! unscripted run and is `null` in a scripted one. A stream's events and frames are read in
//! stream.rs, socket.rs and live.rs. Either style is read through `Settles`: the safe one strictly,
//! so an answer on its outer `Err`, or an `Answer::Err` whose response is not its answer's, fails
//! the run.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};

use serde::Serialize;
use serde_json::Value;

use crate::apply::{How, Prepared};
use crate::protocol::Observed;
use crate::sha256::sha256_hex;
use crate::trace::{result_trace, rust_error};

/// One call's outcome: what the grid observes of it, its error as traced, a safe call's `Answer`
/// summary, and a stream's trace.
#[derive(Default)]
pub struct Outcome {
    pub observed: Option<Value>,
    pub error: Option<Value>,
    pub result: Option<Value>,
    pub stream: Option<Value>,
}

/// How a call of either style ended: its answer and response; an error, with the response when a
/// safe call answered it as an `Answer::Err`; and a safe call's `Answer` summary.
pub enum Settled<T> {
    Answered(T, sdk::RawResponse, Option<Value>),
    Failed(sdk::Error, bool, Option<Value>),
}

/// Reads a call's `.with_response()` outcome in its style.
pub trait Settles: sdk::Style {
    fn settled<T>(out: Self::Out<(T, sdk::RawResponse)>) -> Result<Settled<T>, String>;
}

impl Settles for sdk::Throw {
    fn settled<T>(out: Self::Out<(T, sdk::RawResponse)>) -> Result<Settled<T>, String> {
        Ok(match out {
            Ok((answer, response)) => Settled::Answered(answer, response, None),
            Err(e) => Settled::Failed(e, false, None),
        })
    }
}

/// A safe call's outcome, strictly: an answer is never its outer `Err`, and the response an
/// `Answer` carries is the one its call was answered with (the `on_response` hook's status, an
/// error status's own).
impl Settles for sdk::Safe {
    fn settled<T>(out: Self::Out<(T, sdk::RawResponse)>) -> Result<Settled<T>, String> {
        let answered = ANSWERED.load(Ordering::SeqCst);
        match out {
            Err(e @ (sdk::Error::Api(_) | sdk::Error::Decode(_))) => Err(format!(
                "the safe call returned an API answer as its error: {e}"
            )),
            Err(e) => Ok(Settled::Failed(e, false, None)),
            Ok(sdk::Answer::Ok {
                data: (answer, raw),
                response,
            }) => {
                if response.status != answered || raw.status != response.status {
                    return Err(format!(
                        "an Answer::Ok whose response ({}) is not its answer's ({answered})",
                        response.status
                    ));
                }
                Ok(Settled::Answered(
                    answer,
                    response,
                    Some(result_trace(true, answered)),
                ))
            }
            Ok(sdk::Answer::Err { error, response }) => {
                let e = match error {
                    sdk::SafeError::Api(api) if api.status() == response.status => {
                        sdk::Error::Api(api)
                    }
                    sdk::SafeError::Decode(d) if (200..300).contains(&response.status) => {
                        sdk::Error::Decode(d)
                    }
                    other => {
                        return Err(format!(
                            "an Answer::Err whose response ({}) is not its error's: {other:?}",
                            response.status
                        ));
                    }
                };
                if response.status != answered {
                    return Err(format!(
                        "an Answer::Err whose response ({}) is not its answer's ({answered})",
                        response.status
                    ));
                }
                Ok(Settled::Failed(
                    e,
                    true,
                    Some(result_trace(false, answered)),
                ))
            }
        }
    }
}

/// A call's answer in its style: the data, or an error (via "result" when a safe call answered it).
pub async fn observe<T, S, H>(p: Prepared<T, S, H>) -> Result<Outcome, String>
where
    T: Serialize + Send + 'static,
    S: Settles,
    H: 'static,
{
    let Prepared { call, how } = p;
    let (mut outcome, summary) = match S::settled(call.with_response().await)? {
        Settled::Answered(answer, response, summary) => {
            (answered(answer, &response, &how)?, summary)
        }
        Settled::Failed(e, result, summary) => (
            failed(e, &how, if result { "result" } else { "return" })?,
            summary,
        ),
    };
    outcome.result = summary;
    Ok(outcome)
}

/// `seen` as an outcome.
pub fn observed(seen: Observed) -> Result<Outcome, String> {
    let observed = serde_json::to_value(seen).map_err(|e| e.to_string())?;
    Ok(Outcome {
        observed: Some(observed),
        ..Outcome::default()
    })
}

/// A 2xx answer: the raw response; the bytes of a binary answer; else the data (the body as sent for
/// an untyped answer) with the typed headers, whose failure to read is the call's error.
fn answered<T: Serialize>(
    answer: T,
    response: &sdk::RawResponse,
    how: &How,
) -> Result<Outcome, String> {
    if how.raw {
        return observed(Observed::Raw {
            body: String::from_utf8_lossy(&response.body).into_owned(),
            headers: headers_of(&response.headers),
            status: response.status,
        });
    }
    let value = serde_json::to_value(answer).map_err(|e| format!("encode the answer: {e}"))?;
    if how.binary {
        let bytes: Option<Vec<u8>> = serde_json::from_value(value)
            .map_err(|e| format!("a binary answer is not bytes: {e}"))?;
        let bytes = bytes.unwrap_or_default();
        let (sha256, size) = (sha256_hex(&bytes), bytes.len());
        let status = response.status;
        return observed(Observed::Bytes {
            sha256,
            size,
            status,
        });
    }
    let headers = match how.headers.map(|read| read(&response.headers)).transpose() {
        Ok(headers) => headers,
        Err(e) => return failed(e, how, "return"),
    };
    let data = if how.untyped {
        body_of(&response.body).unwrap_or(Value::Null)
    } else {
        value
    };
    observed(Observed::Data {
        data,
        headers,
        status: response.status,
    })
}

/* the status of the call's last answer, as the `on_response` hook saw it; 0 before any */
static ANSWERED: AtomicU16 = AtomicU16::new(0);

/// An `on_response` hook keeping each answer's status: `Error::Decode` carries none, so an
/// undecodable 2xx is read at the status its answer came with. The driver runs one call at a time.
pub fn answered_status() -> sdk::OnResponseHook {
    Arc::new(keep_status)
}

fn keep_status(ctx: &mut sdk::ResponseContext) -> sdk::HookFuture<'_> {
    ANSWERED.store(ctx.status, Ordering::SeqCst);
    Box::pin(async { Ok(()) })
}

/// Before a call: no answer seen yet.
pub fn forget_status() {
    ANSWERED.store(0, Ordering::SeqCst);
}

/// An error, traced: an error status, a timeout, an undecodable 2xx (`Error::Decode` after a 2xx
/// answer) and no answer (`Error::Transport`) are grid outcomes; any other observes nothing.
pub fn failed(e: sdk::Error, how: &How, via: &str) -> Result<Outcome, String> {
    let error = Some(rust_error(&e, via, how.envelope));
    let answered = ANSWERED.load(Ordering::SeqCst);
    let seen = match &e {
        sdk::Error::Api(api) => Some(api_error(api, how.raw)),
        sdk::Error::Timeout => Some(Observed::Timeout),
        sdk::Error::Decode(_) if (200..300).contains(&answered) => {
            Some(Observed::Decode { status: answered })
        }
        sdk::Error::Transport(_) => Some(Observed::Transport),
        _ => None,
    };
    let observed = seen
        .map(serde_json::to_value)
        .transpose()
        .map_err(|e| e.to_string())?;
    Ok(Outcome {
        observed,
        error,
        ..Outcome::default()
    })
}

/// An error status: the raw response for `raw: true`, else its status, body and error key.
fn api_error(e: &sdk::ApiError, raw: bool) -> Observed {
    if raw {
        return Observed::Raw {
            body: String::from_utf8_lossy(e.body()).into_owned(),
            headers: headers_of(e.headers()),
            status: e.status(),
        };
    }
    Observed::Error {
        body: body_of(e.body()),
        error_key: e.key().map(|k| k.to_string()),
        status: e.status(),
    }
}

/// Typed header field `v` into `m` under `name`: a string as is, anything else as its JSON, an unset
/// one (`None`) left out. A header field is a string, a number or a boolean, which always encode.
pub fn put<T: Serialize>(m: &mut BTreeMap<String, String>, name: &str, v: &T) {
    match serde_json::to_value(v) {
        Ok(Value::Null) | Err(_) => {}
        Ok(Value::String(text)) => {
            m.insert(name.to_owned(), text);
        }
        Ok(other) => {
            m.insert(name.to_owned(), other.to_string());
        }
    }
}

/// A body as the grid observes it: JSON when it is JSON, text when it is not, none when empty.
fn body_of(body: &[u8]) -> Option<Value> {
    if body.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(body);
    Some(serde_json::from_str(&text).unwrap_or(Value::String(text.into_owned())))
}

/// Every header, its name lower case, a repeated one joined with ", ".
fn headers_of(headers: &reqwest::header::HeaderMap) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    for (name, value) in headers {
        let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
        match out.get_mut(name.as_str()) {
            Some(joined) => {
                joined.push_str(", ");
                joined.push_str(&value);
            }
            None => {
                out.insert(name.as_str().to_owned(), value);
            }
        }
    }
    out
}
