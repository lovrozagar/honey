# SDK recipes

Each generated SDK in its own idiom: a client, a call and its typed error, and an event stream released the way the
language releases things. Each excerpt comes from a complete program under `docs/examples/`, compiled against an SDK
generated from a small example API (`Kitchen`) by the docs' tests. Your client is named after your document.

## TypeScript

A client with `throwOnError: true` throws a typed error per status; without it, every call returns a result to
inspect. Leaving a `for await` loop over a stream frees its connection.

```ts sdk
import { Kitchen, NotFoundError } from "./kitchen"

export async function organization(client: Kitchen<true>, orgId: string): Promise<string | null> {
	try {
		await client.getApiV1OrganizationsByOrgId({ params: { orgId } })
		return orgId
	} catch (error) {
		if (error instanceof NotFoundError) return null
		throw error
	}
}
```

## Go

Breaking out of a `range` over a stream closes it; a context ends it quietly.

```go
	for event, err := range client.GetApiEvents(ctx, nil) {
		if err != nil {
			return seen, err
		}
		seen = append(seen, event.Data)
		if len(seen) == limit {
			break // leaving the loop closes the stream and frees its connection
		}
	}
```

## Rust

The SDK is async. Dropping a stream closes its connection.

```rust
    while let Some(event) = stream.next().await {
        seen.push(event?.data);
        if seen.len() == limit {
            break;
        }
    }
```

From blocking code, drive the SDK with a runtime of your own: one per thread, never inside async code. In your own
crate, `tokio::runtime::Runtime::new()` with the `rt-multi-thread` feature does the same.

```rust
fn health_blocking(client: &Client) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(check_health(client))
}
```

## Python

`async with` frees a stream's connection when the block ends; a dropped stream frees it only when it is collected.

```python
    async with await client.get_api_events() as stream:  # leaving the block frees the connection
        async for event in stream:
            seen.append(event.data)
            if len(seen) == limit:
                break
```

## C#

`await using` disposes a stream, and with it its connection.

```csharp
        await using var stream = await client.GetApiEventsAsync(); // disposing it frees the connection
        await foreach (var ev in stream)
        {
            seen.Add(ev.Data);
            if (seen.Count == limit) break;
        }
```

## Java

Open a stream in try-with-resources: a `break` out of a for-each without one keeps the connection.

```java
    try (EventStream<String> stream = client.getApiEvents(GetApiEventsParams.builder().build())) {
      for (SseEvent<String> event : stream) {
        seen.add(event.data());
        if (seen.size() == limit) {
          break;
        }
      }
    }
```
