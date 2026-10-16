//! A call's own options on the method's `Call` (Fb1): its timeout, the headers its plan declares no
//! Opts field for (F6), the alt origin, and the script's cancel; and how its answer is observed.

use std::collections::BTreeMap;
use std::time::Duration;

use crate::protocol::{Call, Input};
use crate::script::{Cancel, Directives};

/// An operation's typed response headers, read through its `FromHeaders` (dispatch.rs writes one per
/// plan that declares them), each by its lower-case name.
pub type ReadHeaders =
    fn(&reqwest::header::HeaderMap) -> Result<BTreeMap<String, String>, sdk::Error>;

/// How a call's answer is observed.
pub struct How {
    /// `raw: true`: the response as it came
    pub raw: bool,
    /// the plan's answer is `none`: the data is the body as sent
    pub untyped: bool,
    /// the plan's answer is `binary`: the bytes' size and SHA-256
    pub binary: bool,
    /// the script asks for an `Api` error's envelope in the trace
    pub envelope: bool,
    /// the plan's typed response headers, read into a data answer
    pub headers: Option<ReadHeaders>,
}

/// A method's call with the grid call's options on it, and how its answer is observed.
pub struct Prepared<T, H> {
    pub call: sdk::Call<T, H>,
    pub how: How,
}

impl<T, H> Prepared<T, H> {
    /// The same call, its typed response headers read by `read`.
    pub fn reading(mut self, read: ReadHeaders) -> Self {
        self.how.headers = Some(read);
        self
    }
}

/// `c` with `call`'s timeout, undeclared headers and origin, and `d`'s cancel, applied.
pub fn apply<T, H>(
    c: sdk::Call<T, H>,
    call: &Call,
    input: &Input,
    d: &Directives,
) -> Prepared<T, H> {
    let plan = &input.plans[&call.operation];
    let mut c = c;
    if let Some(ms) = call.timeout_ms {
        c = c.timeout(Duration::from_millis(ms));
    }
    for (name, value) in &call.headers {
        if !plan
            .headers
            .keys()
            .any(|declared| declared.eq_ignore_ascii_case(name))
        {
            c = c.header(name.clone(), value.clone());
        }
    }
    if let (Some("alt"), Some(alt)) = (call.origin.as_deref(), &input.alt) {
        c = c.base_url(alt.clone());
    }
    match d.cancel {
        None => {}
        Some(Cancel::Before) => c = c.cancel_on(std::future::ready(())),
        Some(Cancel::AfterMs(ms)) => c = c.cancel_on(tokio::time::sleep(Duration::from_millis(ms))),
    }
    let how = How {
        raw: call.raw,
        untyped: plan.response == "none",
        binary: plan.response == "binary",
        envelope: d.envelope,
        headers: None,
    };
    Prepared { call: c, how }
}
