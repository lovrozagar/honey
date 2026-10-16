//! A call's outcome as the grid observes it, read through `.with_response()`: the data and the
//! status; the raw response for `raw: true`; an error status as `error` with its body and honey error
//! key (phase b reads `ApiError`'s raw `error_key`; phase c reads `key()`); a lapsed timeout as
//! `timeout`. Any other error fails the run naming it.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::apply::Prepared;
use crate::protocol::Observed;

/// A throw-mode answer: `T`, or an `Error`.
pub async fn observe<T, H>(p: Prepared<T, H>) -> Result<Value, String>
where
    T: Serialize + Send + 'static,
    H: 'static,
{
    let Prepared { call, raw, untyped } = p;
    let seen = match call.with_response().await {
        Ok((answer, response)) => answered(answer, &response, raw, untyped)?,
        Err(e) => failed(e, raw)?,
    };
    serde_json::to_value(seen).map_err(|e| e.to_string())
}

/// A safe-mode answer: an `SdkResult<T>` holding the data or an error status, or an `Error`.
pub async fn observe_safe<T, H>(p: Prepared<sdk::SdkResult<T>, H>) -> Result<Value, String>
where
    T: Serialize + Send + 'static,
    H: 'static,
{
    let Prepared { call, raw, untyped } = p;
    let seen = match call.with_response().await {
        Ok((result, response)) => match result.error {
            Some(e) => api_error(e, raw),
            None => answered(result.data, &response, raw, untyped)?,
        },
        Err(e) => failed(e, raw)?,
    };
    serde_json::to_value(seen).map_err(|e| e.to_string())
}

/// A 2xx answer: the raw response, or the data (the body as sent for an untyped answer).
fn answered<T: Serialize>(
    answer: T,
    response: &sdk::RawResponse,
    raw: bool,
    untyped: bool,
) -> Result<Observed, String> {
    if raw {
        return Ok(Observed::Raw {
            body: String::from_utf8_lossy(&response.body).into_owned(),
            headers: headers_of(&response.headers),
            status: response.status,
        });
    }
    let data = if untyped {
        body_of(&response.body).unwrap_or(Value::Null)
    } else {
        serde_json::to_value(answer).map_err(|e| format!("encode the answer: {e}"))?
    };
    Ok(Observed::Data {
        data,
        status: response.status,
    })
}

/// An error the grid observes (an error status, a timeout); any other fails the run.
fn failed(e: sdk::Error, raw: bool) -> Result<Observed, String> {
    match e {
        sdk::Error::Api(e) => Ok(api_error(e, raw)),
        sdk::Error::Timeout => Ok(Observed::Timeout),
        other => Err(format!("the call ended in an error the grid has no outcome for: {other}")),
    }
}

/// An error status: the raw response for `raw: true`, else its status, body and error key.
fn api_error(e: sdk::ApiError, raw: bool) -> Observed {
    if raw {
        return Observed::Raw {
            body: String::from_utf8_lossy(&e.body).into_owned(),
            headers: headers_of(&e.headers),
            status: e.status,
        };
    }
    Observed::Error {
        body: body_of(&e.body),
        error_key: e.error_key.clone(),
        status: e.status,
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
