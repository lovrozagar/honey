from __future__ import annotations

import codecs
from typing import AsyncIterator, Iterable, Iterator, TypedDict

import httpx


class SSEEvent(TypedDict, total=False):
    data: str
    event: str
    id: str
    retry: int


DEFAULT_MAX_BUFFER = 1024 * 1024
MAX_EVENT_DATA = 8 * 1024 * 1024


class SSEParser:
    """WHATWG event-stream parser.

    Lines end in CRLF, LF or CR only (never U+2028 and friends, which
    ``str.splitlines`` would also split on). A blank line dispatches the event;
    a final event without its blank line is discarded; the id is sticky across
    events; ``retry`` needs ASCII digits. Each chunk is scanned once.
    """

    def __init__(self, max_line: int = DEFAULT_MAX_BUFFER) -> None:
        self._max_line = max_line
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._line: list[str] = []
        self._line_len = 0
        self._pending_cr = False
        self._first = True
        self._data: list[str] = []
        self._data_len = 0
        self._has_data = False
        self._event: str | None = None
        self._last_id: str | None = None
        self._retry: int | None = None

    def feed(self, chunk: bytes) -> Iterator[SSEEvent]:
        yield from self._feed_text(self._decoder.decode(chunk))

    def feed_text(self, text: str) -> Iterator[SSEEvent]:
        yield from self._feed_text(text)

    def _feed_text(self, text: str) -> Iterator[SSEEvent]:
        start = 0
        for i, ch in enumerate(text):
            if i < start or (ch != "\r" and ch != "\n"):
                continue
            if ch == "\n" and self._pending_cr and i == start:
                # LF completing a CRLF split across chunks
                self._pending_cr = False
                start = i + 1
                continue
            self._pending_cr = False
            self._append(text[start:i])
            line = "".join(self._line)
            self._line = []
            self._line_len = 0
            if ch == "\r":
                if i + 1 < len(text):
                    if text[i + 1] == "\n":
                        start = i + 2
                        event = self._process(line)
                        if event is not None:
                            yield event
                        continue
                else:
                    self._pending_cr = True
            start = i + 1
            event = self._process(line)
            if event is not None:
                yield event
        if start < len(text):
            self._pending_cr = False
            self._append(text[start:])

    def _append(self, part: str) -> None:
        if not part:
            return
        self._line_len += len(part)
        if self._line_len > self._max_line:
            raise RuntimeError(f"SSE line exceeded {self._max_line} characters")
        self._line.append(part)

    def _process(self, line: str) -> SSEEvent | None:
        if self._first:
            self._first = False
            if line.startswith("\ufeff"):
                line = line[1:]
        if line == "":
            return self._dispatch()
        if line.startswith(":"):
            return None
        name, sep, value = line.partition(":")
        if sep and value.startswith(" "):
            value = value[1:]
        if name == "data":
            self._data_len += len(value) + 1
            if self._data_len > MAX_EVENT_DATA:
                raise RuntimeError(f"SSE event exceeded {MAX_EVENT_DATA} characters")
            self._data.append(value)
            self._has_data = True
        elif name == "event":
            self._event = value
        elif name == "id":
            if "\0" not in value:
                self._last_id = value
        elif name == "retry":
            if value and value.isascii() and value.isdigit():
                self._retry = int(value)
        return None

    def _dispatch(self) -> SSEEvent | None:
        event: SSEEvent | None = None
        if self._has_data:
            event = {"data": "\n".join(self._data)}
            if self._event is not None:
                event["event"] = self._event
            if self._last_id is not None:
                event["id"] = self._last_id
            if self._retry is not None:
                event["retry"] = self._retry
        self._data = []
        self._data_len = 0
        self._has_data = False
        self._event = None
        self._retry = None
        return event


def parse_sse_text(chunks: Iterable[str]) -> list[SSEEvent]:
    """Parse already-decoded text chunks; used by the conformance vectors."""
    parser = SSEParser()
    out: list[SSEEvent] = []
    for chunk in chunks:
        out.extend(parser.feed_text(chunk))
    return out


async def parse_sse_stream(
    response: httpx.Response,
    max_buffer_size: int = DEFAULT_MAX_BUFFER,
) -> AsyncIterator[SSEEvent]:
    parser = SSEParser(max_buffer_size)
    async for chunk in response.aiter_bytes():
        for event in parser.feed(chunk):
            yield event


__all__ = ["SSEEvent", "SSEParser", "parse_sse_stream", "parse_sse_text"]
