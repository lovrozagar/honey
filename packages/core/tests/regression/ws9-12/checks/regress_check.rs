// Rust runtime regression checks, run by polyglot.regression.test.ts against an SDK generated from
// rustRuntimeSpec, in this tree and in 3ab88ce. `regress <name>` runs one check and prints
// `REGRESS {json}`. Bodies and options are built with serde_json::from_value so the same source
// compiles against both trees' generated types; results are only formatted, never destructured.

use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use sdk::runtime::{InvalidationConfig, RequestContext};
use sdk::{Client, ClientConfig};
use serde_json::json;

fn base() -> String {
    std::env::var("REGRESS_BASE").expect("REGRESS_BASE")
}

fn report(v: serde_json::Value) {
    println!("REGRESS {}", v);
}

fn client(cfg: ClientConfig) -> Client {
    Client::new(cfg)
}

fn cfg(base_url: String) -> ClientConfig {
    ClientConfig { base_url, ..Default::default() }
}

fn err_text<T, E: std::fmt::Debug + std::fmt::Display>(r: Result<T, E>) -> serde_json::Value {
    match r {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "debug": format!("{:?}", e), "display": format!("{}", e) }),
    }
}

fn opts<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> T {
    serde_json::from_value(v).expect("opts")
}

#[tokio::main]
async fn main() {
    let name = std::env::args().nth(1).expect("check name");
    match name.as_str() {
        // regression: H63
        "h63_refused_is_not_canceled" => {
            let c = client(cfg("http://127.0.0.1:1".into()));
            report(err_text(c.users().get("1", &opts(json!({}))).await));
        }
        // regression: H56b
        "h56b_base_path_kept" => {
            let c = client(cfg(format!("{}/api", base())));
            report(err_text(c.users().get("1", &opts(json!({}))).await));
        }
        // regression: M (codegen-rust.ts:1060 path params)
        "dot_segment_params" => {
            let c = client(cfg(format!("{}/api", base())));
            let mut out = vec![];
            for id in ["..", ".", ""] {
                out.push(err_text(c.users().get(id, &opts(json!({}))).await));
            }
            report(json!(out));
        }
        // regression: M (runtime.rs:394-406,445-458 headers)
        "one_authorization_header" => {
            let mut config = cfg(base());
            config.bearer_token = Some("tok".into());
            config.headers.insert("authorization".into(), "Bearer cfg".into());
            config.headers.insert("x-both".into(), "1".into());
            let mut per_call = std::collections::HashMap::new();
            per_call.insert("X-Both".to_string(), "2".to_string());
            let o = sdk::resources::users::UsersGetOpts { headers: Some(per_call), ..Default::default() };
            report(err_text(client(config).users().get("1", &o).await));
        }
        // regression: M (runtime.rs:400-406,445-447 redirects)
        "cross_host_redirect" => {
            let mut config = cfg(base());
            config.headers.insert("X-Api-Key".into(), "secret".into());
            report(err_text(client(config).hop().get(&opts(json!({}))).await));
        }
        // regression: M (runtime.rs:285-338 refresh)
        "refreshed_token_kept" => {
            let refreshes = Arc::new(Mutex::new(0));
            let counter = refreshes.clone();
            let mut config = cfg(base());
            config.bearer_token = Some("old".into());
            config.on_auth_expired = Some(Arc::new(move || {
                let counter = counter.clone();
                Box::pin(async move {
                    *counter.lock().unwrap() += 1;
                    Ok("new".to_string())
                })
            }));
            let c = client(config);
            let first = err_text(c.users().create(&opts(json!({ "name": "n" })), &opts(json!({}))).await);
            let second = err_text(c.users().get("1", &opts(json!({}))).await);
            let n = *refreshes.lock().unwrap();
            report(json!({ "first": first, "second": second, "refreshes": n }));
        }
        // regression: M (runtime.rs:285-338 single flight)
        "concurrent_401s_refresh_once" => {
            let refreshes = Arc::new(Mutex::new(0));
            let counter = refreshes.clone();
            let mut config = cfg(base());
            config.bearer_token = Some("old".into());
            config.on_auth_expired = Some(Arc::new(move || {
                let counter = counter.clone();
                Box::pin(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    *counter.lock().unwrap() += 1;
                    Ok("new".to_string())
                })
            }));
            let c = client(config);
            let o = opts(json!({}));
            let (a, b, d) = tokio::join!(c.users().get("1", &o), c.users().get("2", &o), c.users().get("3", &o));
            let n = *refreshes.lock().unwrap();
            report(json!({ "results": [err_text(a), err_text(b), err_text(d)], "refreshes": n }));
        }
        // regression: M (invalidation.rs:121-146)
        "paramless_mutation_marks_pattern" => {
            let stale = Arc::new(Mutex::new(Vec::<bool>::new()));
            let seen = stale.clone();
            let mut config = cfg(base());
            config.invalidation = Some(InvalidationConfig { stale_time: 60_000, ..Default::default() });
            config.on_request = vec![Arc::new(move |ctx: &mut RequestContext| {
                let seen = seen.clone();
                let v = ctx.is_stale;
                Box::pin(async move {
                    seen.lock().unwrap().push(v);
                    Ok(())
                })
            })];
            let c = client(config);
            let _ = c.users().create(&opts(json!({ "name": "n" })), &opts(json!({}))).await;
            let _ = c.users().get("1", &opts(json!({}))).await;
            let _ = c.users().get("1", &opts(json!({}))).await;
            let v = stale.lock().unwrap().clone();
            report(json!({ "stale": v }));
        }
        // regression: L (errors.rs:184 error message cap)
        "error_message_capped" => {
            let r = client(cfg(base())).fail().get(&opts(json!({}))).await;
            let len = match &r {
                Ok(_) => 0,
                Err(e) => format!("{}", e).len(),
            };
            report(json!({ "len": len, "result": err_text(r) }));
        }
        // regression: M (codegen-rust.ts:97-98,845,1004 text bodies)
        "text_body" => {
            report(err_text(client(cfg(base())).text().get(&opts(json!({}))).await));
        }
        // regression: H41
        "h41_sse_post" => {
            let mut config = cfg(base());
            config.bearer_token = Some("tok".into());
            let c = client(config);
            let o = opts(json!({ "model": "m" }));
            let body = opts(json!({ "q": "hi" }));
            let stream = c.chat().send(&body, &o);
            futures_util::pin_mut!(stream);
            let mut data = vec![];
            while let Some(ev) = stream.next().await {
                match ev {
                    Ok(e) => data.push(e.data.clone()),
                    Err(e) => {
                        data.push(format!("error: {}", e));
                        break;
                    }
                }
            }
            report(json!({ "events": data }));
        }
        // regression: M (sse.rs:50-51,66-67,80,110-111)
        "sse_parsing" => {
            let c = client(cfg(base()));
            let stream = c.events().list(&opts(json!({})));
            futures_util::pin_mut!(stream);
            let mut data = vec![];
            while let Some(ev) = stream.next().await {
                match ev {
                    Ok(e) => data.push(json!(e.data)),
                    Err(e) => {
                        data.push(json!(format!("error: {}", e)));
                        break;
                    }
                }
            }
            report(json!({ "data": data }));
        }
        // regression: M (sse.rs:32-44,79-93 unbounded buffer)
        "sse_line_capped" => {
            let c = client(cfg(base()));
            let stream = c.events().list(&opts(json!({})));
            futures_util::pin_mut!(stream);
            let mut events = 0;
            let mut largest = 0;
            let mut error = String::new();
            while let Some(ev) = stream.next().await {
                match ev {
                    Ok(e) => {
                        events += 1;
                        largest = largest.max(e.data.len());
                    }
                    Err(e) => {
                        error = format!("{}", e);
                        break;
                    }
                }
            }
            report(json!({ "error": error, "events": events, "largest": largest }));
        }
        // regression: H51
        "h51_array_query" => {
            report(err_text(client(cfg(base())).tags().list(&opts(json!({ "ids": ["a", "b"] }))).await));
        }
        // regression: NEW (M) nullable query values
        "nullable_query_unquoted" => {
            report(err_text(client(cfg(base())).tags().list(&opts(json!({ "maybe": "foo" }))).await));
        }
        other => panic!("unknown check {other}"),
    }
}
