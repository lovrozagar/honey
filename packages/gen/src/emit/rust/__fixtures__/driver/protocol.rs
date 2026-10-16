//! The driver's side of the shared protocol (emit/shared/__fixtures__/protocol.ts; the grid's types in
//! tests/integration/conformance/matrix.ts): the stdin envelope, the grid's Setup and Call decoded
//! strictly (a member this driver does not know fails the cell instead of being dropped), and the
//! grid's Observed. `Script` and `Trace` join with the script, in phase c.

use std::collections::BTreeMap;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The envelope on stdin.
#[derive(Deserialize)]
pub struct Input {
    pub cell: Cell,
    #[serde(default)]
    pub plans: BTreeMap<String, Plan>,
    pub base: String,
    pub alt: Option<String>,
    pub script: Option<Value>,
}

/// What the driver reads of a grid Cell; its calls are decoded strictly one by one.
#[derive(Deserialize)]
pub struct Cell {
    pub setup: Option<Value>,
    pub calls: Vec<Value>,
}

/// What the driver reads of a call plan as it runs: the header params the Opts carry, and the answer's kind.
#[derive(Deserialize)]
pub struct Plan {
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub response: String,
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

/// The grid's Call. Every member is listed so strict decoding knows it; `refusal` names the ones the
/// driver cannot express yet.
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
    /// What of the call this driver cannot express yet, with the phase that lands it.
    pub fn refusal(&self) -> Option<String> {
        let stream = [
            ("send", self.send.is_some()),
            ("take", self.take.is_some()),
            ("lastEventId", self.last_event_id.is_some()),
            ("reconnectToken", self.reconnect_token.is_some()),
        ];
        if let Some((member, _)) = stream.iter().find(|(_, set)| *set) {
            return Some(refused(member, "d"));
        }
        matches!(self.body, Some(Body::Binary { .. })).then(|| refused("a binary body", "c"))
    }

    /// The query param `name`, as the grid gives it.
    pub fn search(&self, name: &str) -> Option<Value> {
        self.search.get(name).cloned()
    }

    /// The header `name`, whatever its case, as a JSON string.
    pub fn header_param(&self, name: &str) -> Option<Value> {
        let (_, value) = self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name))?;
        Some(Value::String(value.clone()))
    }

    /// The path param `name`.
    pub fn param(&self, name: &str) -> Result<String, String> {
        self.params.get(name).cloned().ok_or_else(|| format!("the call has no path param {name}"))
    }

    /// The JSON body, decoded as the method's body parameter.
    pub fn json_body<T: DeserializeOwned>(&self) -> Result<T, String> {
        match &self.body {
            Some(Body::Json { value }) => from(value.clone()),
            _ => Err("the method takes a body, and the call has no JSON body".into()),
        }
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

/// A refusal's reason: `member` is expressed from phase `phase` on.
pub fn refused(member: &str, phase: &str) -> String {
    format!("{member} arrives in phase {phase}")
}

/// The grid's Observed, as far as phase b observes.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Observed {
    Data {
        data: Value,
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
}
