//! The driver's side of the shared protocol (emit/shared/__fixtures__/protocol.ts; the grid's types in
//! tests/integration/conformance/matrix.ts): the stdin envelope, the grid's Setup and Call decoded
//! strictly (a member this driver does not know fails the cell instead of being dropped), and the
//! grid's Observed. The script a unit test adds is decoded as strictly (`Script`, `Directives`); its
//! trace is written in trace.rs. `stream_refusal` names the stream controls a call or its script sets
//! that its operation's kind cannot take.

use std::collections::BTreeMap;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::script::Directives;

/// The envelope on stdin.
#[derive(Deserialize)]
pub struct Input {
    pub cell: Cell,
    #[serde(default)]
    pub plans: BTreeMap<String, Plan>,
    pub base: String,
    pub alt: Option<String>,
    pub drop: Option<String>,
    pub refused: Option<String>,
    pub script: Option<Value>,
}

/// What the driver reads of a grid Cell; its calls are decoded strictly one by one.
#[derive(Deserialize)]
pub struct Cell {
    pub setup: Option<Value>,
    pub calls: Vec<Value>,
}

/// What the driver reads of a call plan as it runs: the header params the Opts carry, the answer's
/// kind, the Opts field of the idempotency key, and the stream's kind (`sse`, `ws`, `realtime`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub idempotency_key: Option<String>,
    pub response: String,
    pub stream: Option<String>,
}

/// The grid's Setup: the client-wide settings of a cell.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Setup {
    pub auth: Option<Auth>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub redirect: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// The grid's Auth: a bearer token, or a credential under a header name.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Auth {
    Bearer { token: String },
    Header { name: String, value: String },
}

/// The grid's Call. Every member is listed so strict decoding knows it; `stream_refusal` names the
/// stream controls its operation cannot take.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Call {
    pub body: Option<Body>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub last_event_id: Option<String>,
    pub operation: String,
    pub origin: Option<String>,
    #[serde(default)]
    pub params: BTreeMap<String, String>,
    #[serde(default)]
    pub raw: bool,
    pub reconnect_token: Option<String>,
    pub route: Option<Value>,
    #[serde(default)]
    pub search: BTreeMap<String, Value>,
    pub send: Option<Vec<String>>,
    pub take: Option<u64>,
    pub timeout_ms: Option<u64>,
}

/// The grid's Body: a JSON value, or binary bytes of a size.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Body {
    Json {
        value: Value,
    },
    Binary {
        #[serde(rename = "contentType")]
        content_type: String,
        size: usize,
    },
}

impl Call {
    /// The query param `name`, as the grid gives it.
    pub fn search(&self, name: &str) -> Option<Value> {
        self.search.get(name).cloned()
    }

    /// The header `name`, whatever its case, as a JSON string.
    pub fn header_param(&self, name: &str) -> Option<Value> {
        let (_, value) = self
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))?;
        Some(Value::String(value.clone()))
    }

    /// The path param `name`.
    pub fn param(&self, name: &str) -> Result<String, String> {
        self.params
            .get(name)
            .cloned()
            .ok_or_else(|| format!("the call has no path param {name}"))
    }

    /// The JSON body, decoded as the method's body parameter.
    pub fn json_body<T: DeserializeOwned>(&self) -> Result<T, String> {
        match &self.body {
            Some(Body::Json { value }) => from(value.clone()),
            _ => Err("the method takes a body, and the call has no JSON body".into()),
        }
    }

    /// The binary body, `size` bytes `i & 0xff`: in memory, or as a stream sent once (no length, no
    /// resend) when `one_shot`.
    pub fn binary_body(&self, one_shot: bool) -> Result<sdk::Body, String> {
        let Some(Body::Binary { size, .. }) = &self.body else {
            return Err("the method takes a binary body, and the call has no binary body".into());
        };
        let bytes: Vec<u8> = (0..*size).map(|i| (i & 0xff) as u8).collect();
        if !one_shot {
            return Ok(bytes.into());
        }
        let chunk = Ok::<_, std::io::Error>(bytes::Bytes::from(bytes));
        Ok(sdk::Body::from_stream(futures_util::stream::iter([chunk])))
    }

    /// The JSON body, a string, as a text body.
    pub fn text_body(&self) -> Result<String, String> {
        self.json_body()
    }

    /// Ok when the call has no body: the method takes none.
    pub fn no_body(&self) -> Result<(), String> {
        match self.body {
            None => Ok(()),
            Some(_) => Err("the call has a body, and the method takes no body parameter".into()),
        }
    }
}

/// `v` decoded as the field or parameter it sets; a header's text that is not that type's JSON string
/// is read as JSON (a number, a boolean).
pub fn from<T: DeserializeOwned>(v: Value) -> Result<T, String> {
    match serde_json::from_value(v.clone()) {
        Ok(t) => Ok(t),
        Err(e) => match v {
            Value::String(text) => serde_json::from_str(&text).map_err(|_| e.to_string()),
            _ => Err(e.to_string()),
        },
    }
}

/// What of `call` and its directives `d` the operation of `plan` cannot take: a stream control on an
/// operation that does not stream, or one its stream's kind has no use for; none when it fits.
pub fn stream_refusal(call: &Call, plan: &Plan, d: &Directives) -> Option<String> {
    let set: [(&str, bool, &[&str]); 7] = [
        ("take", call.take.is_some(), &["sse", "ws", "realtime"]),
        ("send", call.send.is_some(), &["ws", "realtime"]),
        (
            "lastEventId",
            call.last_event_id.is_some(),
            &["sse", "realtime"],
        ),
        (
            "reconnectToken",
            call.reconnect_token.is_some(),
            &["ws", "realtime"],
        ),
        ("protocols", d.protocols.is_some(), &["ws", "realtime"]),
        ("a realtime script", d.realtime.is_some(), &["realtime"]),
        ("a ws script", d.ws.is_some(), &["ws"]),
    ];
    let Some(kind) = plan.stream.as_deref() else {
        let (member, ..) = set.iter().find(|(_, on, _)| *on)?;
        return Some(format!("{member} on an operation that does not stream"));
    };
    let label = match kind {
        "sse" => "an SSE",
        "ws" => "a WebSocket",
        _ => "a realtime",
    };
    if call.raw {
        return Some(format!(
            "raw: true on {label} operation, which has no single response to read"
        ));
    }
    if let Some((member, ..)) = set
        .iter()
        .find(|(_, on, kinds)| *on && !kinds.contains(&kind))
    {
        let why = match *member {
            "send" => ": only a WebSocket or realtime call sends",
            "lastEventId" => ": only an SSE or realtime call resumes by event id",
            "reconnectToken" => ": only a WebSocket or realtime call resumes by token",
            "protocols" => ": only a WebSocket or realtime dial offers subprotocols",
            _ => "",
        };
        return Some(format!("{member} on {label} operation{why}"));
    }
    (kind == "realtime" && call.take.is_none())
        .then(|| "a realtime call needs take: the connection never ends by itself".into())
}

/// The grid's Observed: phase c's answers, a stream's events (SSE) and frames (WebSocket, realtime).
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Observed {
    Data {
        data: Value,
        /// the operation's typed response headers, read through its `FromHeaders`
        #[serde(skip_serializing_if = "Option::is_none")]
        headers: Option<BTreeMap<String, String>>,
        status: u16,
    },
    Bytes {
        sha256: String,
        size: usize,
        status: u16,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<Value>,
        #[serde(rename = "errorKey")]
        error_key: Option<String>,
        status: u16,
    },
    Raw {
        body: String,
        headers: BTreeMap<String, String>,
        status: u16,
    },
    Timeout,
    /// a 2xx whose body did not decode (`Error::Decode`), at the status the answer carried
    Decode {
        status: u16,
    },
    /// no answer: `Error::Transport`
    Transport,
    Events {
        events: Vec<Value>,
        /// the no-answer error the stream ended in after its events, when it did (f2)
        #[serde(skip_serializing_if = "Option::is_none")]
        failed: Option<&'static str>,
    },
    Frames {
        frames: Vec<Value>,
    },
}
