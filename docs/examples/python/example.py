"""A Python program against an SDK generated from the Kitchen example API: a client, a call and its typed error, the
same call through ``client.safe`` narrowed by ``match``, and an event stream released through ``async with``.
Type-checked by mypy --strict in the docs' tests."""

import asyncio
import os
import sys

from honey_sdk import APIStatusError, AsyncSDK, ClientConfig, DecodeError, Err, Ok


def new_client() -> AsyncSDK:
    return AsyncSDK(
        ClientConfig(base_url="https://api.example.com", bearer_token=os.environ.get("KITCHEN_TOKEN"), timeout=10)
    )


async def check_health(client: AsyncSDK) -> str | None:
    try:
        await client.get_api_health()
    except APIStatusError as failed:
        return f"health check answered {failed.status}"
    return None


async def health(client: AsyncSDK) -> str:
    match await client.safe.get_api_health():
        case Ok(data, response):
            return f"answered {response.status}: {data}"
        case Err(DecodeError() as unreadable, response):
            return f"answered {response.status}, unreadable: {unreadable}"
        case Err(error, response):
            return f"answered {response.status}: {error}"


async def first_events(client: AsyncSDK, limit: int) -> list[str]:
    seen: list[str] = []
    async with await client.get_api_events() as stream:  # leaving the block frees the connection
        async for event in stream:
            seen.append(event.data)
            if len(seen) == limit:
                break
    return seen


async def main() -> None:
    async with new_client() as client:
        print(await check_health(client))
        print(await health(client))
        print(await first_events(client, 2))


if __name__ == "__main__" and len(sys.argv) > 1:
    asyncio.run(main())
