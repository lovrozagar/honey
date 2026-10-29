//! A realtime call's reads (contract 20 §4.2): `ResumableConnection<E>`, opened by the method across
//! its transport chain. dispatch.rs declares this file only for an SDK with a realtime operation.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use crate::apply::Prepared;
use crate::observe::{Outcome, failed};
use crate::protocol::{Call, Observed};
use crate::stream::streamed;
use crate::trace::rust_error;

/// The method's open connection: each grid `send` as its JSON value (else as raw text, send_text), so the
/// wire carries the text; then `take` values read (protocol.rs refuses a realtime call without one),
/// each as its JSON. The first send or read error is traced via "stream" and ends the reads, a read
/// error also kept in `realtime.errors`; a connection that ends first (closed or canceled) ends them
/// quietly. Then `close`, and the trace: the frames read, the settled resume cursor (`""` when
/// unset), the proven transport and the read errors, with `close`'s error.
pub async fn observe_live<E>(
    p: Prepared<sdk::ResumableConnection<E>, sdk::Throw, ()>,
    call: &Call,
) -> Result<Outcome, String>
where
    E: Serialize + DeserializeOwned + Send + 'static,
{
    let Prepared { call: c, how } = p;
    let mut rc = match c.with_response().await {
        Ok((rc, _)) => rc,
        Err(e) => return failed(e, &how, "return"),
    };
    let (mut frames, mut errors, mut failure) = (Vec::new(), Vec::new(), None);
    for text in call.send.iter().flatten() {
        let sent = match serde_json::from_str::<Value>(text) {
            Ok(message) => rc.send(&message).await,
            Err(_) => rc.send_text(text).await,
        };
        if let Err(e) = sent {
            failure = Some(e);
            break;
        }
    }
    let take = call.take.unwrap_or_default();
    while failure.is_none() && (frames.len() as u64) < take {
        match rc.recv().await {
            None => break,
            Some(Ok(value)) => frames
                .push(serde_json::to_value(value).map_err(|e| format!("encode a frame: {e}"))?),
            Some(Err(e)) => {
                errors.push(e.to_string());
                failure = Some(e);
            }
        }
    }
    let mut st = Map::new();
    if let Err(e) = rc.close().await {
        st.insert("closeError".into(), json!(e.to_string()));
    }
    let cursor = json!({
        "lastEventId": rc.last_event_id().unwrap_or_default(),
        "reconnectToken": rc.reconnect_token().unwrap_or_default(),
    });
    let proven = rc.proven_transport().map(|kind| match kind {
        sdk::TransportKind::WebSocket => "ws",
        sdk::TransportKind::Sse => "sse",
        sdk::TransportKind::LongPoll => "longpoll",
    });
    st.insert(
        "realtime".into(),
        json!({"cursor": cursor, "errors": errors, "proven": proven}),
    );
    st.insert("yields".into(), json!(frames.len()));
    match failure {
        /* a connection whose first read failed, refused before any frame, ends in its open's error: the grid's error or timeout */
        Some(e @ (sdk::Error::Api(_) | sdk::Error::Timeout)) if frames.is_empty() && !errors.is_empty() => {
            let mut outcome = failed(e, &how, "stream")?;
            outcome.stream = Some(Value::Object(st));
            Ok(outcome)
        }
        failure => {
            let error = failure.map(|e| rust_error(&e, "stream", how.envelope));
            streamed(Observed::Frames { frames }, error, st)
        }
    }
}
