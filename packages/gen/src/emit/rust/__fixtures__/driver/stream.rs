//! A stream call's reads (contract 20 §4.2), the SSE half here; socket.rs and live.rs hold the
//! WebSocket and realtime ones. Every stream opens through `.with_response()`: an error status at the
//! open is the grid's `error` and a lapsed timeout its `timeout`, any other failure before a stream
//! existed observes `null`, each traced via "return". Once open, the call observes what the stream
//! delivered, and an error the stream yields is traced via "stream". A stream call runs under
//! `STALL_AFTER` (main.rs): one that never ends fails the run instead of hanging it.

use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::apply::Prepared;
use crate::observe::{Outcome, failed, observed};
use crate::protocol::Observed;
use crate::trace::rust_error;

/// How long a stream call may run before the run fails.
pub const STALL_AFTER: Duration = Duration::from_secs(10);

/// What a stream call delivered as an outcome: `seen`, the first error the stream yielded, and its
/// trace `st` (protocol.ts `StreamTrace`).
pub fn streamed(
    seen: Observed,
    error: Option<Value>,
    st: Map<String, Value>,
) -> Result<Outcome, String> {
    let mut outcome = observed(seen)?;
    outcome.error = error;
    outcome.stream = Some(Value::Object(st));
    Ok(outcome)
}

/// An SSE operation's `EventStream<T>`, read until `take` events (absent: until its end), then
/// dropped, which closes it. A yielded error is kept (the first) and the reads carry on, as Go's
/// driver does, so a stream that does not end after its error shows in `yields`. The trace holds
/// the yields (events and errors), each event's `retry` (null when unset) and the typed headers
/// that were sent.
pub async fn observe_events<T, H>(
    p: Prepared<sdk::EventStream<T>, H>,
    take: Option<u64>,
) -> Result<Outcome, String>
where
    T: Serialize + Send + 'static,
    H: 'static,
{
    let Prepared { call, how } = p;
    let (mut stream, response) = match call.with_response().await {
        Ok(opened) => opened,
        Err(e) => return failed(e, &how, "return"),
    };
    let headers = match how.headers.map(|read| read(&response.headers)).transpose() {
        Ok(headers) => headers,
        Err(e) => return failed(e, &how, "return"),
    };
    let (mut events, mut retry, mut yields, mut error) = (Vec::new(), Vec::new(), 0, None);
    while take.is_none_or(|n| (events.len() as u64) < n) {
        let Some(item) = stream.next().await else {
            break;
        };
        yields += 1;
        match item {
            Ok(event) => {
                retry.push(json!(event.retry));
                events.push(event_of(event)?);
            }
            Err(e) => {
                error.get_or_insert_with(|| rust_error(&e, "stream", how.envelope));
            }
        }
    }
    let mut st = Map::new();
    st.insert("yields".into(), json!(yields));
    if !retry.is_empty() {
        st.insert("retry".into(), json!(retry));
    }
    if let Some(headers) = headers.filter(|h| !h.is_empty()) {
        st.insert("headers".into(), json!(headers));
    }
    streamed(Observed::Events { events }, error, st)
}

/// An event as the grid observes it: its data as JSON (a string for text events), its event name
/// and id only when set.
fn event_of<T: Serialize>(e: sdk::SseEvent<T>) -> Result<Value, String> {
    let data = serde_json::to_value(e.data).map_err(|e| format!("encode an event's data: {e}"))?;
    let mut out = Map::new();
    out.insert("data".into(), data);
    if !e.event.is_empty() {
        out.insert("event".into(), json!(e.event));
    }
    if !e.id.is_empty() {
        out.insert("id".into(), json!(e.id));
    }
    Ok(Value::Object(out))
}
