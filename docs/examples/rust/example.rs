// A Rust program against an SDK generated from the Kitchen example API: a client, a call and its typed error, an
// event stream released by dropping it, and the async SDK called from blocking code. Built by the docs' tests.
use sdk::{Client, ClientConfig, Error};
use sdk::{GetApiEventsOpts, GetApiHealthOpts};

fn new_client() -> Result<Client, Error> {
    Client::new(ClientConfig {
        base_url: "https://api.example.com".into(),
        bearer_token: std::env::var("KITCHEN_TOKEN").ok(),
        timeout: Some(std::time::Duration::from_secs(10)),
        ..ClientConfig::default()
    })
}

async fn check_health(client: &Client) -> Result<(), String> {
    match client.get_api_health(&GetApiHealthOpts::default()).await {
        Ok(()) => Ok(()),
        Err(Error::Api(failed)) => Err(format!("health check answered {}", failed.status())),
        Err(other) => Err(other.to_string()),
    }
}

async fn first_events(client: &Client, limit: usize) -> Result<Vec<String>, Error> {
    let mut stream = client.get_api_events(&GetApiEventsOpts::default()).await?;
    let mut seen = Vec::new();
    while let Some(event) = stream.next().await {
        seen.push(event?.data);
        if seen.len() == limit {
            break;
        }
    }
    Ok(seen) // dropping the stream closes its connection
}

/// The SDK is async; blocking code drives it with a runtime of its own: one per thread, never inside async code.
fn health_blocking(client: &Client) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(check_health(client))
}

fn main() {
    if std::env::args().len() < 2 {
        return;
    }
    let client = new_client().expect("a valid config");
    println!("{:?}", health_blocking(&client));
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a runtime");
    println!("{:?}", runtime.block_on(first_events(&client, 2)).map_err(|error| error.to_string()));
}
