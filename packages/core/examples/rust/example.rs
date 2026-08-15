/* ============================================================================
 * Honey SDK — Rust end-to-end example
 *
 * Assumes ../mock-sdk/ crate was generated via
 * generateRustSDK(spec, { crateName: "mock-sdk" }) and is wired in Cargo.toml as
 *     [dependencies]
 *     mock-sdk = { path = "../mock-sdk" }
 *     tokio = { version = "1", features = ["full"] }
 *     tokio-util = { version = "0.7", features = ["rt"] }
 *     futures-util = "0.3"
 *     bytes = "1"
 *
 * This file is DOCUMENTATION — not a compile target. Types referenced below
 * exist only after codegen.
 *
 * Demonstrates the cross-lang parity surface:
 *   1. Client init + config                   9.  Per-call headers merge
 *   2. Typed operation call                  10.  Invalidation + is_stale
 *   3. Typed error hierarchy                 11.  SSE iteration
 *   4. Declared error payload (.data)        12.  WebSocket bidi + close
 *   5. on_auth_expired + 1x 401 retry        13.  Realtime + Transport trait
 *   6. on_request / on_response hooks        14.  Streaming upload
 *   7. on_log lifecycle                      15.  x-idempotency-key
 *   8. Per-call timeout override             16.  CancellationToken + Arc<AtomicBool>
 * ========================================================================== */

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::stream;
use futures_util::StreamExt;
use mock_sdk::client::{
    ConnectRealtimeOpts, ConnectWsOpts, CreateUserOpts, GetUserOpts, IdempotentCreateOpts,
    SlowOpts, StreamEventsOpts, UpdateUserOpts, UploadBlobOpts,
};
use mock_sdk::errors::{
    BadRequestError, Error, InternalServerError, NotFoundError, RateLimitError, UnauthorizedError,
};
use mock_sdk::realtime::{ResumableConnection, Transport, TransportConn, TransportKind, TransportOpts};
use mock_sdk::runtime::{InvalidationConfig, LogEntry, OnRequestHook, OnResponseHook};
use mock_sdk::types::{UserCreate, UserUpdate};
use mock_sdk::{Client, ClientConfig};
use sha2::{Digest, Sha256};
use std::env;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base_url = env::var("BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".into());

    /* §6: hooks are Arc<dyn Fn + Send + Sync>. Declaration order = execution order. */
    let trace_hook: OnRequestHook = Arc::new(|ctx| {
        Box::pin(async move {
            ctx.headers.insert("X-Trace-Id".into(), "trace-123".into());
            Ok(())
        })
    });
    let app_hook: OnRequestHook = Arc::new(|ctx| {
        Box::pin(async move {
            ctx.headers.insert("X-App".into(), "example".into());
            Ok(())
        })
    });
    let inspect_hook: OnResponseHook = Arc::new(|ctx| {
        let status = ctx.status;
        Box::pin(async move {
            if status >= 500 {
                eprintln!("5xx: {}", status);
            }
            Ok(())
        })
    });

    /* §1 + §5 + §7 + §10: client config. Mechanism, not policy. */
    let client = Client::new(ClientConfig {
        base_url,
        bearer_token: Some("expired-token".into()),
        /* §5: exactly one retry on 401. Return Ok(None) to let 401 propagate. */
        on_auth_expired: Some(Arc::new(|| Box::pin(async { Ok(Some("valid-token".into())) }))),
        /* §7: single pluggable sink — NOT a logger framework. */
        on_log: Some(Arc::new(|e: LogEntry| {
            println!("{} {} {} {:?}", e.event, e.operation, e.duration_ms, e.status);
        })),
        on_request: vec![trace_hook, app_hook],
        on_response: vec![inspect_hook],
        invalidation: InvalidationConfig { stale_time_ms: 5_000 },
        timeout: Some(Duration::from_secs(10)),
        ..Default::default()
    });

    /* §2 + §3 + §4: typed call + typed error hierarchy via Error::Api +
     * downcast_ref. Each *Error carries status_code, body, and typed data. */
    match client
        .create_user(
            &UserCreate { name: "Alice".into(), email: "a@b.com".into() },
            &CreateUserOpts::default(),
        )
        .await
    {
        Ok(user) => println!("{} {}", user.id, user.name),
        Err(Error::Api(api_err)) => {
            let dyn_err: &(dyn std::error::Error + 'static) = api_err.as_ref();
            if let Some(bre) = dyn_err.downcast_ref::<BadRequestError>() {
                println!("400 data: {:?} body_len: {}", bre.data, bre.body.len());
            } else if dyn_err.downcast_ref::<UnauthorizedError>().is_some() {
                println!("401");
            } else if dyn_err.downcast_ref::<NotFoundError>().is_some() {
                println!("404");
            } else if dyn_err.downcast_ref::<RateLimitError>().is_some() {
                println!("429 — backoff per consumer policy");
            } else if dyn_err.downcast_ref::<InternalServerError>().is_some() {
                println!("500");
            }
        }
        Err(e) => eprintln!("{}", e),
    }

    /* §8: per-call timeout override via opts. */
    if let Err(e) = client
        .slow(&SlowOpts { ms: Some(200), timeout: Some(Duration::from_millis(50)), ..Default::default() })
        .await
    {
        eprintln!("aborted: {}", e);
    }

    /* §9: per-call headers merge over config headers; per-call wins per key. */
    let _ = client
        .get_user(
            "u1",
            &GetUserOpts {
                headers: Some([("X-Both".into(), "call-wins".into())].into_iter().collect()),
                ..Default::default()
            },
        )
        .await;

    /* §10: mutation invalidates matching GET paths. */
    let _ = client
        .update_user(
            "u1",
            &UserUpdate { name: Some("Alice2".into()), ..Default::default() },
            &UpdateUserOpts::default(),
        )
        .await;
    println!("users/u1 stale? {}", client.is_stale("GET", "/users/u1"));

    /* §11: SSE — async stream iteration. */
    let mut sse = client.stream_events(&StreamEventsOpts::default()).await?;
    if let Some(ev) = sse.next().await {
        println!("sse event: {:?}", ev);
    }

    /* §12: WebSocket — bidi channel. */
    let mut ws = client.connect_ws(&ConnectWsOpts::default()).await?;
    ws.send("hello".to_string()).await?;
    if let Some(msg) = ws.recv().await {
        println!("ws recv: {:?}", msg);
    }
    ws.close(1000, "done").await?;

    /* §13: x-realtime ResumableConnection. Transport trait is the swap point;
     * the chain memoizes a proven transport across reconnects (hidden). */
    let tick_adapter: Arc<dyn Transport + Send + Sync> = Arc::new(TickAdapter);
    let mut rc = client
        .connect_realtime(&ConnectRealtimeOpts {
            transports: vec![tick_adapter],
            max_reconnect_attempts: 5,
            reconnect_delay_ms: 100,
            ..Default::default()
        })
        .await?;
    if let Some(ev) = rc.next().await {
        println!("rt event: {:?}", ev);
    }
    rc.close().await;

    /* §14: streaming upload — impl Stream<Item = Bytes>. No buffering. */
    const TOTAL: usize = 1024 * 1024;
    const CHUNK: usize = 64 * 1024;
    let mut buf = vec![0u8; TOTAL];
    for (i, b) in buf.iter_mut().enumerate() {
        *b = (i & 0xff) as u8;
    }
    let expected = hex::encode(Sha256::digest(&buf));
    let chunks: Vec<Bytes> = buf.chunks(CHUNK).map(|c| Bytes::copy_from_slice(c)).collect();
    let body_stream = stream::iter(chunks.into_iter().map(Ok::<_, std::io::Error>));
    let uploaded = client.upload_blob(body_stream, &UploadBlobOpts::default()).await?;
    println!("uploaded: {} {} expected: {}", uploaded.size, uploaded.hash, expected);

    /* §15: x-idempotency-key — auto UUID, explicit opts field, header override. */
    let auto = client.idempotent_create(&IdempotentCreateOpts::default()).await?;
    let explicit = client
        .idempotent_create(&IdempotentCreateOpts {
            idempotency_key: Some("user-supplied-123".into()),
            ..Default::default()
        })
        .await?;
    let via_header = client
        .idempotent_create(&IdempotentCreateOpts {
            headers: Some([("Idempotency-Key".into(), "header-wins-456".into())].into_iter().collect()),
            ..Default::default()
        })
        .await?;
    println!("{} {} {}", auto.idempotency_key, explicit.idempotency_key, via_header.idempotency_key);

    /* §16 (async): tokio_util::sync::CancellationToken. Cancel propagates to
     * reqwest, WS, SSE, and ResumableConnection. */
    let token = CancellationToken::new();
    let token_clone = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(25)).await;
        token_clone.cancel();
    });
    if let Err(e) = client
        .slow(&SlowOpts { ms: Some(500), cancel_token: Some(token), ..Default::default() })
        .await
    {
        eprintln!("cancelled async: {}", e);
    }

    Ok(())
}

/* §13: minimal custom Transport impl. Real transports wrap tokio-tungstenite
 * (WS), reqwest + eventsource-stream (SSE), or longpoll. */
struct TickAdapter;

#[async_trait]
impl Transport for TickAdapter {
    fn name(&self) -> &str { "tick" }
    fn kind(&self) -> TransportKind { TransportKind::Ws }

    async fn connect(
        &self,
        _url: &str,
        _opts: &TransportOpts,
    ) -> Result<Box<dyn TransportConn + Send>, Error> {
        Ok(Box::new(TickConn { sent: false }))
    }
}

struct TickConn { sent: bool }

#[async_trait]
impl TransportConn for TickConn {
    async fn recv(&mut self) -> Option<serde_json::Value> {
        if self.sent {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            return None;
        }
        self.sent = true;
        Some(serde_json::json!({ "kind": "tick" }))
    }
    async fn send(&mut self, _data: serde_json::Value) -> Result<(), Error> { Ok(()) }
    async fn close(&mut self) -> Result<(), Error> { Ok(()) }
    fn kind(&self) -> TransportKind { TransportKind::Ws }
}
