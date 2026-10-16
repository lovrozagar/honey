//! A WebSocket call's reads (contract 20 §4.2): `TypedWebSocket`, driven past the grid's `send` and
//! `take` by the script's `ws` entry (script.rs `WsScript`). dispatch.rs declares this file only for
//! an SDK with a WebSocket or realtime operation, so an SDK without one builds no socket code.

use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{Map, Value, json};

use crate::apply::Prepared;
use crate::observe::{Outcome, failed};
use crate::protocol::{Call, Observed};
use crate::script::{Directives, WsMessage, WsScript};
use crate::stream::streamed;
use crate::trace::rust_error;

/// The `on` handlers' runs in firing order, each `{event, data}`.
type Runs = Arc<Mutex<Vec<Value>>>;

fn lock(runs: &Runs) -> MutexGuard<'_, Vec<Value>> {
    /* a handler that panicked while holding the lock left nothing half-written: each write is one push */
    runs.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The handler recording each run of `event` into `runs`, its data as text.
fn recording(event: &'static str, runs: &Runs) -> impl FnMut(&[u8]) + Send + 'static {
    let runs = Arc::clone(runs);
    move |data: &[u8]| {
        lock(&runs).push(json!({"data": String::from_utf8_lossy(data), "event": event}))
    }
}

/// The method's open socket: a recording handler per `WsEvent` under `ws.on`; the grid's `send` as
/// text, then the script's messages; `recv` until `take` frames (absent: until `None`), each its JSON,
/// else its text; then `close` with the script's code and reason (1000 and none by default). A failed
/// send ends the sends, not the reads: what the server sent first (its close frame, say) still waits
/// to be read. The first send or read error is traced via "stream". The trace holds the frames read,
/// every handler run (those `close` fires included), the server's close frame and `close`'s error.
pub async fn observe_frames(
    p: Prepared<sdk::TypedWebSocket, ()>,
    call: &Call,
    d: &Directives,
) -> Result<Outcome, String> {
    let Prepared { call: c, how } = p;
    let mut ws = match c.with_response().await {
        Ok((ws, _)) => ws,
        Err(e) => return failed(e, &how, "return"),
    };
    let none = WsScript::default();
    let script = d.ws.as_ref().unwrap_or(&none);
    let runs = Runs::default();
    if script.on {
        ws.on(sdk::WsEvent::Message, recording("message", &runs));
        ws.on(sdk::WsEvent::Close, recording("close", &runs));
        ws.on(sdk::WsEvent::Error, recording("error", &runs));
    }
    let mut frames = Vec::new();
    let unsent = sent(&mut ws, call, script).await.err();
    let unread = read(&mut ws, call.take, &mut frames).await;
    let failure = unsent.or(unread);
    let mut st = Map::new();
    if let Some(by) = ws.closed_by() {
        st.insert(
            "closedBy".into(),
            json!({"code": by.code, "reason": by.reason}),
        );
    }
    let (code, reason) = script
        .close
        .as_ref()
        .map_or((1000, ""), |c| (c.code, c.reason.as_str()));
    if let Err(e) = ws.close(code, reason).await {
        st.insert("closeError".into(), json!(e.to_string()));
    }
    let handlers = lock(&runs).clone();
    if !handlers.is_empty() {
        st.insert("handlers".into(), json!(handlers));
    }
    st.insert("yields".into(), json!(frames.len()));
    let error = failure.map(|e| rust_error(&e, "stream", how.envelope));
    streamed(Observed::Frames { frames }, error, st)
}

/// The grid's `send` as text frames, then each scripted message by its kind.
async fn sent(
    ws: &mut sdk::TypedWebSocket,
    call: &Call,
    script: &WsScript,
) -> Result<(), sdk::Error> {
    for text in call.send.iter().flatten() {
        ws.send_text(text.clone()).await?;
    }
    for message in &script.send {
        match message {
            WsMessage::Json(value) => ws.send_json(value).await?,
            WsMessage::Text(text) => ws.send_text(text.clone()).await?,
            WsMessage::Bytes(n) => {
                let data: Vec<u8> = (0..*n).map(|i| (i & 0xff) as u8).collect();
                ws.send_binary(data).await?;
            }
        }
    }
    Ok(())
}

/// Frames read into `frames` until `take` (absent: until the socket ends); the error that ended them.
async fn read(
    ws: &mut sdk::TypedWebSocket,
    take: Option<u64>,
    frames: &mut Vec<Value>,
) -> Option<sdk::Error> {
    while take.is_none_or(|n| (frames.len() as u64) < n) {
        match ws.recv().await {
            None => break,
            Some(Ok(data)) => frames
                .push(serde_json::from_slice(&data).unwrap_or_else(|_| {
                    Value::String(String::from_utf8_lossy(&data).into_owned())
                })),
            Some(Err(e)) => return Some(e),
        }
    }
    None
}
