/* Behavior checks for the generated Rust runtime; built as a binary by ../polyglot-runtime.test.ts. */
use mock_sdk::client::{CreateUserOpts, GetUserOpts};
use mock_sdk::errors::Error;
use mock_sdk::realtime::{
    LongpollTransport, RealtimeError, ResumableConnection, ResumableConnectionOpts, SseTransport, Transport,
    TransportConn, TransportKind, TransportOpts,
};
use mock_sdk::types::UserCreate;
use mock_sdk::{Client, ClientConfig};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Handler = Arc<dyn Fn(&str) -> (u16, String, String) + Send + Sync>;

/* tiny HTTP/1.1 server: one request per connection; the handler sees the raw request head + body */
fn serve(handler: Handler) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut s = match stream { Ok(s) => s, Err(_) => continue };
            let h = handler.clone();
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    if n == 0 { break; }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some(i) = text.find("\r\n\r\n") {
                        let len = text[..i].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if buf.len() >= i + 4 + len { break; }
                    }
                }
                let req = String::from_utf8_lossy(&buf).to_string();
                let (status, ctype, body) = h(&req);
                let resp = format!("HTTP/1.1 {} X\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", status, ctype, body.len(), body);
                let _ = s.write_all(resp.as_bytes());
            });
        }
    });
    format!("http://{}", addr)
}

fn header_count(req: &str, name: &str) -> usize {
    req.lines().filter(|l| l.to_ascii_lowercase().starts_with(&format!("{}:", name))).count()
}

struct Flaky { calls: Arc<AtomicU32> }
struct DyingConn;
struct OkConn { sent: bool }

#[async_trait::async_trait]
impl Transport for Flaky {
    fn name(&self) -> &'static str { "flaky" }
    fn kind(&self) -> TransportKind { TransportKind::Ws }
    async fn connect(&self, _u: &str, _o: &TransportOpts) -> Result<Box<dyn TransportConn>, RealtimeError> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        if n == 0 { return Ok(Box::new(DyingConn)); }
        tokio::time::sleep(Duration::from_millis(50)).await;
        Ok(Box::new(OkConn { sent: false }))
    }
}
#[async_trait::async_trait]
impl TransportConn for DyingConn {
    async fn send_json(&mut self, _v: serde_json::Value) -> Result<(), RealtimeError> { Ok(()) }
    async fn recv_json(&mut self) -> Result<serde_json::Value, RealtimeError> { Err(RealtimeError::Closed) }
    async fn close(&mut self) -> Result<(), RealtimeError> { Ok(()) }
    fn kind(&self) -> TransportKind { TransportKind::Ws }
}
#[async_trait::async_trait]
impl TransportConn for OkConn {
    async fn send_json(&mut self, _v: serde_json::Value) -> Result<(), RealtimeError> { Ok(()) }
    async fn recv_json(&mut self) -> Result<serde_json::Value, RealtimeError> {
        if self.sent { tokio::time::sleep(Duration::from_secs(3600)).await; }
        self.sent = true;
        Ok(serde_json::json!({"ok": true}))
    }
    async fn close(&mut self) -> Result<(), RealtimeError> { Ok(()) }
    fn kind(&self) -> TransportKind { TransportKind::Ws }
}

#[tokio::main]
async fn main() {
    let mut out: HashMap<&str, bool> = HashMap::new();

    /* H63: refused connection is a Transport error, not Canceled */
    let c = Client::new(ClientConfig { base_url: "http://127.0.0.1:1".into(), ..Default::default() });
    let r = c.get_user("u1", &GetUserOpts::default()).await;
    out.insert("refused is Transport", matches!(r, Err(Error::Transport(_))));

    /* headers merge once; base path kept; path param encoded; refreshed token kept, one refresh */
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    let base = serve(Arc::new(move |req: &str| {
        s2.lock().unwrap().push(req.to_string());
        if !req.contains("authorization: Bearer fresh") && !req.contains("Authorization: Bearer fresh") {
            return (401, "application/json".into(), "{}".into());
        }
        (200, "application/json".into(), r#"{"id":"u1","name":"A","email":"e"}"#.into())
    }));
    let refreshes = Arc::new(AtomicU32::new(0));
    let r2 = refreshes.clone();
    let mut headers = HashMap::new();
    headers.insert("authorization".to_string(), "Bearer other".to_string());
    let c = Client::new(ClientConfig {
        base_url: format!("{}/api", base),
        bearer_token: Some("stale".into()),
        headers,
        on_auth_expired: Some(Arc::new(move || { r2.fetch_add(1, Ordering::SeqCst); Box::pin(async { Ok("fresh".to_string()) }) })),
        ..Default::default()
    });
    let created = c.create_user(&UserCreate { name: "A".into(), email: "e".into() }, &CreateUserOpts::default()).await;
    let _ = c.get_user("a b/c", &GetUserOpts::default()).await;
    let reqs = seen.lock().unwrap().clone();
    out.insert("create retried and succeeded", created.is_ok() && reqs.len() == 3);
    let body = |r: &String| r.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
    out.insert("retry resent the body", reqs.len() >= 2 && !body(&reqs[0]).is_empty() && body(&reqs[0]) == body(&reqs[1]));
    out.insert("single authorization", reqs.iter().all(|r| header_count(r, "authorization") == 1));
    out.insert("single content-type", header_count(&reqs[0], "content-type") == 1);
    out.insert("token kept, one refresh", refreshes.load(Ordering::SeqCst) == 1);
    out.insert("base path kept and encoded", reqs.last().map(|r| r.starts_with("GET /api/users/a%20b%2Fc ")).unwrap_or(false));
    let bad = c.get_user("..", &GetUserOpts::default()).await;
    out.insert("dot-dot rejected", matches!(bad, Err(Error::Other(ref m)) if m.contains("Invalid path param")));

    /* error messages capped and cleaned */
    let base = serve(Arc::new(|_r: &str| (500, "text/plain".into(), format!("\u{1b}]0;x\u{7}{}", "y".repeat(3000)))));
    let c = Client::new(ClientConfig { base_url: base, ..Default::default() });
    let msg = match c.get_user("u", &GetUserOpts::default()).await { Err(e) => e.to_string(), Ok(_) => String::new() };
    out.insert("error message capped", msg.chars().count() < 700 && !msg.contains('\u{1b}'));

    /* H66/H65: longpoll and SSE transports fail on error statuses instead of looping */
    let base = serve(Arc::new(|_r: &str| (400, "application/json".into(), r#"{"error":"missing token"}"#.into())));
    let mut lp = LongpollTransport::default().connect(&base, &TransportOpts::default()).await.unwrap();
    let res = tokio::time::timeout(Duration::from_secs(5), lp.recv_json()).await;
    out.insert("longpoll 400 is an error", matches!(res, Ok(Err(_))));
    let sse = SseTransport::default().connect(&base, &TransportOpts::default()).await;
    out.insert("sse 400 is a connect error", sse.is_err());

    /* H64: a recv dropped mid-reconnect does not leave the connection dead */
    let calls = Arc::new(AtomicU32::new(0));
    let mut rc = ResumableConnection::<serde_json::Value, serde_json::Value>::connect(
        "http://x".into(),
        ResumableConnectionOpts { reconnect_delay_ms: Some(10), max_reconnect_attempts: Some(5), ..Default::default() },
        vec![Box::new(Flaky { calls: calls.clone() })],
    ).await.unwrap();
    let first = tokio::time::timeout(Duration::from_millis(15), rc.recv()).await;
    let second = tokio::time::timeout(Duration::from_secs(5), rc.recv()).await;
    out.insert("recv is cancel-safe", first.is_err() && matches!(second, Ok(Ok(_))));

    /* invalidation: a param-less mutation keeps the templated target as a pattern */
    let tracker = mock_sdk::invalidation::StaleTracker::new(Some(&mock_sdk::runtime::InvalidationConfig { stale_time: 60_000, ..Default::default() }));
    tracker.mark_stale(&["GET /users/{user-id}".to_string()], &HashMap::new(), "POST /x").await;
    out.insert("pattern target kept", tracker.is_stale("GET", "/users/42").await);

    println!("{}", serde_json::to_string(&out).unwrap());
}
