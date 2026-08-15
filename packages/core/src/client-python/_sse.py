from __future__ import annotations

import re
from typing import AsyncIterator, TypedDict

import httpx


class SSEEvent(TypedDict, total=False):
    data: str
    event: str
    id: str
    retry: int


def _parse_sse_block(block: str) -> SSEEvent | None:
    lines = block.splitlines()
    is_comment = True
    data: str | None = None
    event: str | None = None
    id_val: str | None = None
    retry: int | None = None

    for line in lines:
        if line.startswith(":"):
            continue
        is_comment = False
        colon_idx = line.find(":")
        if colon_idx == -1:
            field_name = line
            val = ""
        else:
            field_name = line[:colon_idx]
            val = line[colon_idx + 1:]
            if val.startswith(" "):
                val = val[1:]

        if field_name == "data":
            data = val if data is None else f"{data}\n{val}"
        elif field_name == "event":
            event = val
        elif field_name == "id":
            # per SSE spec: id containing null byte must be ignored
            if "\0" not in val:
                id_val = val
        elif field_name == "retry":
            try:
                n = int(val)
                if n >= 0:
                    retry = n
            except ValueError:
                pass

    if is_comment or data is None:
        return None

    result: SSEEvent = {"data": data}
    if event is not None:
        result["event"] = event
    if id_val is not None:
        result["id"] = id_val
    if retry is not None:
        result["retry"] = retry
    return result


DEFAULT_MAX_BUFFER = 1024 * 1024

_SSE_BLOCK_RE = re.compile(r"\r\n\r\n|\r\n\r|\r\n\n|\r\r\n|\n\r\n|\n\r|\r\r|\n\n")


async def parse_sse_stream(
    response: httpx.Response,
    max_buffer_size: int = DEFAULT_MAX_BUFFER,
) -> AsyncIterator[SSEEvent]:
    buffer = ""
    async for chunk in response.aiter_text():
        buffer += chunk
        if len(buffer) > max_buffer_size:
            raise RuntimeError(f"SSE buffer exceeded {max_buffer_size} characters")

        # split on double-newline (any combo of \r\n, \r, \n)
        blocks = _SSE_BLOCK_RE.split(buffer)
        buffer = blocks.pop()

        for block in blocks:
            if not block.strip():
                continue
            event = _parse_sse_block(block)
            if event is not None:
                yield event

    if buffer.strip():
        event = _parse_sse_block(buffer)
        if event is not None:
            yield event


__all__ = ["SSEEvent", "parse_sse_stream"]
