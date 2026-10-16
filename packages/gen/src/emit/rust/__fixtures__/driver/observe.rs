//! A call's outcome as the grid observes it, read through `.with_response()` and the SDK's accessors:
//! the data and the status (with the typed response headers when the plan declares them); a binary
//! answer's size and SHA-256; the raw response for `raw: true`; an error status as `error` with its
//! body and honey error key (`ApiError::key()`); a lapsed timeout as `timeout`. Every error is also
//! traced (`trace::rust_error`); one the grid has no outcome for observes nothing, which fails an
//! unscripted run and is `null` in a scripted one.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::apply::{How, Prepared};
use crate::protocol::Observed;
use crate::sha256::sha256_hex;
use crate::trace::{result_trace, rust_error};

/// One call's outcome: what the grid observes of it, its error as traced, a safe-mode result's summary.
#[derive(Default)]
pub struct Outcome {
    pub observed: Option<Value>,
    pub error: Option<Value>,
    pub result: Option<Value>,
}

/// A throw-mode answer: `T`, or an `Error`.
pub async fn observe<T, H>(p: Prepared<T, H>) -> Result<Outcome, String>
where
    T: Serialize + Send + 'static,
    H: 'static,
{
    let Prepared { call, how } = p;
    match call.with_response().await {
        Ok((answer, response)) => answered(answer, &response, &how),
        Err(e) => failed(e, &how, "return"),
    }
}

/// A safe-mode answer: an `SdkResult<T>` holding the data or an error status, or an `Error`.
pub async fn observe_safe<T, H>(p: Prepared<sdk::SdkResult<T>, H>) -> Result<Outcome, String>
where
    T: Serialize + Send + 'static,
    H: 'static,
{
    let Prepared { call, how } = p;
    let (result, response) = match call.with_response().await {
        Ok(answered) => answered,
        Err(e) => return failed(e, &how, "return"),
    };
    let summary = result_trace(&result);
    let mut outcome = match result.error {
        Some(e) => failed(sdk::Error::Api(e), &how, "result")?,
        None => answered(result.data, &response, &how)?,
    };
    outcome.result = Some(summary);
    Ok(outcome)
}

/// `seen` as an outcome.
fn observed(seen: Observed) -> Result<Outcome, String> {
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

/// An error, traced: an error status and a timeout are grid outcomes; any other observes nothing.
fn failed(e: sdk::Error, how: &How, via: &str) -> Result<Outcome, String> {
    let error = Some(rust_error(&e, via, how.envelope));
    let seen = match &e {
        sdk::Error::Api(api) => Some(api_error(api, how.raw)),
        sdk::Error::Timeout => Some(Observed::Timeout),
        _ => None,
    };
    let observed = seen
        .map(serde_json::to_value)
        .transpose()
        .map_err(|e| e.to_string())?;
    Ok(Outcome {
        observed,
        error,
        result: None,
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
