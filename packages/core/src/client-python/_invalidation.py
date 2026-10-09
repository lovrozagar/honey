from __future__ import annotations

import asyncio
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote


def _now() -> float:
    return time.monotonic()


# `{name}` (any name without braces or slashes) or a `:name` segment; a colon
# inside a segment (`/ops/{id}:cancel`) is literal.
_PATH_PARAM_RE = re.compile(r"\{([^{}/]+)\}|(?:(?<=/)|^):([a-zA-Z_][a-zA-Z0-9_]*)")


@dataclass
class _StaleEntry:
    by: list[str] = field(default_factory=list)
    seq: int = 0
    until: float = 0.0


@dataclass
class _RequestMeta:
    selector: str
    is_stale: bool
    invalidated_by: list[str]
    seq_snapshot: int


def path_matches_pattern(
    path: str,
    pattern: str,
    _cache: dict[str, re.Pattern[str]] = {},
) -> bool:
    """Match *path* against *pattern* containing ``{name}`` / ``:name`` placeholders."""
    if pattern not in _cache:
        escaped_parts: list[str] = []
        last_end = 0
        for match in _PATH_PARAM_RE.finditer(pattern):
            escaped_parts.append(re.escape(pattern[last_end : match.start()]))
            escaped_parts.append("[^/]+")
            last_end = match.end()
        escaped_parts.append(re.escape(pattern[last_end:]))
        _cache[pattern] = re.compile(f"^{''.join(escaped_parts)}$")
    return bool(_cache[pattern].match(path))


def interpolate_path(template: str, params: dict[str, str] | None) -> str:
    """Substitute ``{name}`` / ``:name`` placeholders in *template* using *params*.

    Raises ValueError if any placeholder has no matching key in *params*.
    """
    if not params:
        if _PATH_PARAM_RE.search(template) is not None:
            raise ValueError(f"Missing path params for template {template!r}")
        return template

    def _sub(match: re.Match[str]) -> str:
        key = match.group(1) or match.group(2)
        if key not in params or params[key] is None:
            raise ValueError(f"Missing path param: {key}")
        return quote(str(params[key]), safe="")

    return _PATH_PARAM_RE.sub(_sub, template)


def _has_unresolved(value: str) -> bool:
    return _PATH_PARAM_RE.search(value) is not None


def resolve_invalidation_targets_for_mutation(
    targets: list[str],
    params: dict[str, str] | None,
) -> list[str]:
    """Expand ``METHOD /path/{id}`` template invalidation targets to concrete selectors.

    Targets without placeholders are passed through. A target whose placeholders cannot
    all be resolved stays a pattern, so it marks every instance stale (TS parity).
    """
    resolved: list[str] = []
    for entry in targets:
        space_idx = entry.find(" ")
        if space_idx == -1:
            resolved.append(entry)
            continue
        method = entry[:space_idx]
        template = entry[space_idx + 1 :]
        if not _has_unresolved(template):
            resolved.append(entry)
            continue
        try:
            concrete = interpolate_path(template, params)
        except ValueError:
            resolved.append(entry)
            continue
        resolved.append(f"{method} {concrete}")
    return resolved


def resolve_invalidation_targets(
    invalidate: list[str],
    stale_map: "OrderedDict[str, _StaleEntry] | OrderedDict[str, Any]",
) -> list[str]:
    """Return *stale_map* keys matching any 'METHOD /pattern' invalidation entry.

    Kept for back-compat with existing call sites that pass an already-built map.
    """
    matched: list[str] = []
    for entry in invalidate:
        for key in list(stale_map.keys()):
            parts = key.split(" ", 1)
            if len(parts) != 2:
                continue
            key_method, key_path = parts
            entry_parts = entry.split(" ", 1)
            if len(entry_parts) != 2:
                continue
            entry_method, entry_pattern = entry_parts
            if key_method != entry_method:
                continue
            if path_matches_pattern(key_path, entry_pattern):
                matched.append(key)
    return matched


def lookup_stale(key: str, stale_map: "OrderedDict[str, Any]") -> bool:
    """Return True if *key* exists in *stale_map* and has not yet expired."""
    entry = stale_map.get(key)
    if entry is None:
        return False
    until = entry.until if isinstance(entry, _StaleEntry) else entry["until"]
    return _now() < until


class _StaleStore:
    """Stale state shared by the async and sync trackers; callers hold their own lock.

    Concrete keys are looked up directly; keys that still hold ``{name}``
    placeholders are also indexed per method, so a lookup scans only the patterns
    of its method, not every entry. Expired concrete entries go on access, expired
    patterns when scanned, and the rest when the map is over capacity.
    """

    def __init__(
        self, stale_time: float, stale_max_entries: int, max_sources_per_target: int
    ) -> None:
        self.enabled = stale_time > 0
        self.stale_time = max(stale_time, 0.0)
        self.max_entries = max(stale_max_entries, 1)
        self.max_sources = max(max_sources_per_target, 1)
        self.map: OrderedDict[str, _StaleEntry] = OrderedDict()
        self.patterns: dict[str, dict[str, None]] = {}
        self.seq = 0

    def delete(self, key: str) -> None:
        if self.map.pop(key, None) is None:
            return
        method, path = _split_key(key)
        bucket = self.patterns.get(method)
        if bucket is not None and _has_unresolved(path):
            bucket.pop(key, None)
            if not bucket:
                del self.patterns[method]

    def upsert(
        self, key: str, until: float, seq: int, mutation_selector: str | None
    ) -> None:
        existing = self.map.get(key)
        if existing is not None:
            existing.until = until
            existing.seq = seq
            if mutation_selector and mutation_selector not in existing.by:
                if len(existing.by) < self.max_sources:
                    existing.by.append(mutation_selector)
            self.map.move_to_end(key)
            return
        by = [mutation_selector] if mutation_selector else []
        self.map[key] = _StaleEntry(by=by, seq=seq, until=until)
        method, path = _split_key(key)
        if _has_unresolved(path):
            self.patterns.setdefault(method, {})[key] = None

    def invalidate(self, patterns: list[str]) -> None:
        self.evict_expired()
        targets = resolve_invalidation_targets(patterns, self.map)
        self.seq += 1
        until = _now() + self.stale_time
        for t in targets:
            self.upsert(t, until, self.seq, None)
        self.enforce_capacity()

    def mark_stale(
        self,
        invalidate: list[str],
        params: dict[str, str] | None,
        mutation_selector: str,
    ) -> None:
        self.seq += 1
        until = _now() + self.stale_time
        for target in resolve_invalidation_targets_for_mutation(invalidate, params):
            self.upsert(target, until, self.seq, mutation_selector)
        self.enforce_capacity()

    def mark(self, key: str) -> None:
        self.seq += 1
        self.upsert(key, _now() + self.stale_time, self.seq, None)
        self.enforce_capacity()

    def lookup(
        self, concrete_selector: str, concrete_path: str, method: str, now: float
    ) -> tuple[list[str], bool]:
        all_by: list[str] = []
        exact = self.map.get(concrete_selector)
        if exact is not None:
            if exact.until > now:
                all_by.extend(exact.by)
            else:
                self.delete(concrete_selector)
        expired: list[str] = []
        for key in self.patterns.get(method, {}):
            entry = self.map[key]
            if entry.until <= now:
                expired.append(key)
                continue
            if key != concrete_selector and path_matches_pattern(
                concrete_path, _split_key(key)[1]
            ):
                all_by.extend(entry.by)
        for key in expired:
            self.delete(key)
        deduped = list(dict.fromkeys(all_by))
        return deduped, len(deduped) > 0

    def clear(
        self, concrete_selector: str, concrete_path: str, method: str, seq_snapshot: int
    ) -> None:
        exact = self.map.get(concrete_selector)
        if exact and exact.seq <= seq_snapshot:
            self.delete(concrete_selector)
        to_delete = [
            key
            for key in self.patterns.get(method, {})
            if self.map[key].seq <= seq_snapshot
            and path_matches_pattern(concrete_path, _split_key(key)[1])
        ]
        for key in to_delete:
            self.delete(key)

    def request_meta(
        self, concrete_selector: str, concrete_path: str, method: str
    ) -> _RequestMeta:
        by, is_stale = self.lookup(concrete_selector, concrete_path, method, _now())
        return _RequestMeta(
            selector=concrete_selector,
            is_stale=is_stale,
            invalidated_by=by,
            seq_snapshot=self.seq,
        )

    def evict_expired(self) -> None:
        now = _now()
        for key in [k for k, v in self.map.items() if now >= v.until]:
            self.delete(key)

    def enforce_capacity(self) -> None:
        if len(self.map) <= self.max_entries:
            return
        self.evict_expired()
        target = max(self.max_entries // 2, 1)
        while len(self.map) > target:
            self.delete(next(iter(self.map)))


def _split_key(key: str) -> tuple[str, str]:
    space_idx = key.find(" ")
    if space_idx == -1:
        return key, ""
    return key[:space_idx], key[space_idx + 1 :]


def _split_method_path(method_or_key: str, path: str | None) -> tuple[str, str]:
    if path is None:
        return _split_key(method_or_key)
    return method_or_key, path


class _StaleTracker:
    """Async-aware stale tracker backed by ``asyncio.Lock``."""

    def __init__(
        self,
        stale_time: float,
        stale_max_entries: int = 1000,
        max_sources_per_target: int = 16,
    ) -> None:
        """stale_time == 0 disables the tracker (no stale window applied)."""
        self._store = _StaleStore(stale_time, stale_max_entries, max_sources_per_target)
        self._lock = asyncio.Lock()

    @property
    def enabled(self) -> bool:
        return self._store.enabled

    @property
    def _map(self) -> "OrderedDict[str, _StaleEntry]":
        return self._store.map

    async def invalidate(self, patterns: list[str]) -> None:
        """Mark every existing key matching *patterns* as freshly stale."""
        if not self.enabled:
            return
        async with self._lock:
            self._store.invalidate(patterns)

    async def mark_stale(
        self,
        invalidate: list[str],
        params: dict[str, str] | None,
        mutation_selector: str,
    ) -> None:
        """Bump seq, expand templated invalidation entries, store stale keys."""
        if not self.enabled or not invalidate:
            return
        async with self._lock:
            self._store.mark_stale(invalidate, params, mutation_selector)

    async def mark(self, key: str) -> None:
        """Force *key* into the stale map. Used by SSE/WS open hooks and tests."""
        if not self.enabled:
            return
        async with self._lock:
            self._store.mark(key)

    async def is_stale(self, method_or_key: str, path: str | None = None) -> bool:
        """Return True if (method, path) is currently stale.

        Accepts either ``is_stale("GET /users")`` or ``is_stale("GET", "/users")``.
        Walks pattern entries too.
        """
        if not self.enabled:
            return False
        method, concrete_path = _split_method_path(method_or_key, path)
        async with self._lock:
            return self._store.lookup(
                f"{method} {concrete_path}", concrete_path, method, _now()
            )[1]

    async def lookup_stale(
        self,
        concrete_selector: str,
        concrete_path: str,
        method: str,
    ) -> tuple[list[str], bool]:
        """Return (invalidated_by_list, is_stale): exact + pattern lookup with sweep."""
        if not self.enabled:
            return [], False
        async with self._lock:
            return self._store.lookup(concrete_selector, concrete_path, method, _now())

    async def clear_stale(
        self,
        concrete_selector: str,
        concrete_path: str,
        method: str,
        seq_snapshot: int,
    ) -> None:
        """Drop seq-older entries matching *concrete_path* (exact + pattern keys)."""
        if not self.enabled:
            return
        async with self._lock:
            self._store.clear(concrete_selector, concrete_path, method, seq_snapshot)

    async def build_request_meta(
        self,
        concrete_selector: str,
        concrete_path: str,
        method: str,
    ) -> _RequestMeta | None:
        if not self.enabled:
            return None
        async with self._lock:
            return self._store.request_meta(concrete_selector, concrete_path, method)

    @staticmethod
    def _split_key(key: str) -> tuple[str, str]:
        return _split_key(key)


class _StaleTrackerSync:
    """Sync variant backed by ``threading.Lock``; mirrors :class:`_StaleTracker`."""

    def __init__(
        self,
        stale_time: float,
        stale_max_entries: int = 1000,
        max_sources_per_target: int = 16,
    ) -> None:
        """stale_time == 0 disables the tracker (no stale window applied)."""
        self._store = _StaleStore(stale_time, stale_max_entries, max_sources_per_target)
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self._store.enabled

    @property
    def _map(self) -> "OrderedDict[str, _StaleEntry]":
        return self._store.map

    def invalidate(self, patterns: list[str]) -> None:
        if not self.enabled:
            return
        with self._lock:
            self._store.invalidate(patterns)

    def mark_stale(
        self,
        invalidate: list[str],
        params: dict[str, str] | None,
        mutation_selector: str,
    ) -> None:
        if not self.enabled or not invalidate:
            return
        with self._lock:
            self._store.mark_stale(invalidate, params, mutation_selector)

    def mark(self, key: str) -> None:
        if not self.enabled:
            return
        with self._lock:
            self._store.mark(key)

    def is_stale(self, method_or_key: str, path: str | None = None) -> bool:
        if not self.enabled:
            return False
        method, concrete_path = _split_method_path(method_or_key, path)
        with self._lock:
            return self._store.lookup(
                f"{method} {concrete_path}", concrete_path, method, _now()
            )[1]

    def lookup_stale(
        self,
        concrete_selector: str,
        concrete_path: str,
        method: str,
    ) -> tuple[list[str], bool]:
        if not self.enabled:
            return [], False
        with self._lock:
            return self._store.lookup(concrete_selector, concrete_path, method, _now())

    def clear_stale(
        self,
        concrete_selector: str,
        concrete_path: str,
        method: str,
        seq_snapshot: int,
    ) -> None:
        if not self.enabled:
            return
        with self._lock:
            self._store.clear(concrete_selector, concrete_path, method, seq_snapshot)

    def build_request_meta(
        self,
        concrete_selector: str,
        concrete_path: str,
        method: str,
    ) -> _RequestMeta | None:
        if not self.enabled:
            return None
        with self._lock:
            return self._store.request_meta(concrete_selector, concrete_path, method)


__all__ = [
    "_RequestMeta",
    "_StaleEntry",
    "_StaleTracker",
    "_StaleTrackerSync",
    "interpolate_path",
    "lookup_stale",
    "path_matches_pattern",
    "resolve_invalidation_targets",
    "resolve_invalidation_targets_for_mutation",
]
