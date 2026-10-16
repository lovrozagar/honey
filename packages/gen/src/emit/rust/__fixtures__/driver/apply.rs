//! A call's own options on the method's `Call` (Fb1): its timeout, the headers its plan declares no
//! Opts field for (F6), and the alt origin.

use std::time::Duration;

use crate::protocol::{Call, Input};

/// A method's call with the grid call's options on it, and how its answer is observed.
pub struct Prepared<T, H> {
    pub call: sdk::Call<T, H>,
    /// `raw: true`: the response as it came
    pub raw: bool,
    /// the plan's answer is `none`: the data is the body as sent
    pub untyped: bool,
}

/// `c` with `call`'s timeout, undeclared headers and origin applied.
pub fn apply<T, H>(c: sdk::Call<T, H>, call: &Call, input: &Input) -> Prepared<T, H> {
    let plan = &input.plans[&call.operation];
    let mut c = c;
    if let Some(ms) = call.timeout_ms {
        c = c.timeout(Duration::from_millis(ms));
    }
    for (name, value) in &call.headers {
        if !plan.headers.keys().any(|declared| declared.eq_ignore_ascii_case(name)) {
            c = c.header(name.clone(), value.clone());
        }
    }
    if let (Some("alt"), Some(alt)) = (call.origin.as_deref(), &input.alt) {
        c = c.base_url(alt.clone());
    }
    Prepared {
        call: c,
        raw: call.raw,
        untyped: plan.response == "none",
    }
}
