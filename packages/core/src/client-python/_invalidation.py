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


_PATH_PARAM_RE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}|:([a-zA-Z_][a-zA-Z0-9_]*)")


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

    Targets without placeholders are passed through. Targets whose placeholders cannot
    be resolved against *params* are dropped (no point storing a half-templated key).
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


class _StaleTracker:
    """Async-aware stale tracker backed by ``asyncio.Lock``."""

    def __init__(
        self,
        stale_time: float,
        stale_max_entries: int = 1000,
        max_sources_per_target: int = 16,
    ) -> None:
        """ stale_time == 0 disables the tracker (no stale window applied). """
        self._enabled = stale_time > 0
        self._stale_time = max(stale_time, 0.0)
        self._max_entries = max(stale_max_entries, 1)
        self._max_sources = max(max_sources_per_target, 1)
        self._map: OrderedDict[str, _StaleEntry] = OrderedDict()
        self._lock = asyncio.Lock()
        self._seq = 0

    @property
    def enabled(self) -> bool:
        return self._enabled

    async def invalidate(self, patterns: list[str]) -> None:
        """Mark every existing key matching *patterns* as freshly stale."""
        if not self._enabled:
            return
        async with self._lock:
            self._evict_expired()
            targets = resolve_invalidation_targets(patterns, self._map)
            self._seq += 1
            until = _now() + self._stale_time
            for t in targets:
                self._upsert(t, until, self._seq, mutation_selector=None)
            self._enforce_capacity()

    async def mark_stale(
        self,
        invalidate: list[str],
        params: dict[str, str] | None,
        mutation_selector: str,
    ) -> None:
        """Bump seq, expand templated invalidation entries, store stale keys."""
        if not self._enabled or not invalidate:
            return
        async with self._lock:
            self._seq += 1
            until = _now() + self._stale_time
            resolved = resolve_invalidation_targets_for_mutation(invalidate, params)
            for target in resolved:
                self._upsert(
                    target, until, self._seq, mutation_selector=mutation_selector,
                )
            self._enforce_capacity()

    async def mark(self, key: str) -> None:
        """Force *key* into the stale map. Used by SSE/WS open hooks and tests."""
        if not self._enabled:
            return
        async with self._lock:
            self._seq += 1
            until = _now() + self._stale_time
            self._upsert(key, until, self._seq, mutation_selector=None)
            self._enforce_capacity()

    async def is_stale(self, method_or_key: str, path: str | None = None) -> bool:
        """Return True if (method, path) is currently stale.

        Accepts either ``is_stale("GET /users")`` or ``is_stale("GET", "/users")``.
        Walks pattern entries too.
        """
        if not self._enabled:
            return False
        if path is None:
            method, concrete_path = self._split_key(method_or_key)
        else:
            method, concrete_path = method_or_key, path
        async with self._lock:
            now = _now()
            _by, is_stale = self._lookup_locked(
                concrete_selector=f"{method} {concrete_path}",
                concrete_path=concrete_path,
                method=method,
                now=now,
            )
            return is_stale

    async def lookup_stale(
        self,
        concrete_selector: str,
        concrete_path: str,
        method: str,
    ) -> tuple[list[str], bool]:
        """Return (invalidated_by_list, is_stale): exact + pattern lookup with sweep."""
        if not self._enabled:
            return [], False
        async with self._lock:
            return self._lookup_locked(concrete_selector, concrete_path, method, _now())

    async def clear_stale(
        self,
        concrete_selector: str,
        concrete_path: str,
        method: str,
        seq_snapshot: int,
    ) -> None:
        """Drop seq-older entries matching *concrete_path* (exact + pattern keys)."""
        if not self._enabled:
            return
        async with self._lock:
            exact = self._map.get(concrete_selector)
            if exact and exact.seq <= seq_snapshot:
                del self._map[concrete_selector]
            to_delete: list[str] = []
            for key, entry in self._map.items():
                if entry.seq > seq_snapshot:
                    continue
                key_method, key_pattern = self._split_key(key)
                if "{" not in key_pattern and ":" not in key_pattern:
                    continue
                if key_method != method:
                    continue
                if path_matches_pattern(concrete_path, key_pattern):
                    to_delete.append(key)
            for key in to_delete:
                del self._map[key]

    async def build_request_meta(
        self,
        concrete_selector: str,
        concrete_path: str,
        method: str,
    ) -> _RequestMeta | None:
        if not self._enabled:
            return None
        async with self._lock:
            by, is_stale = self._lookup_locked(
                concrete_selector, concrete_path, method, _now(),
            )
            return _RequestMeta(
                selector=concrete_selector,
                is_stale=is_stale,
                invalidated_by=by,
                seq_snapshot=self._seq,
            )

    def _upsert(
        self,
        key: str,
        until: float,
        seq: int,
        mutation_selector: str | None,
    ) -> None:
        existing = self._map.get(key)
        if existing is not None:
            existing.until = until
            existing.seq = seq
            if mutation_selector and mutation_selector not in existing.by:
                if len(existing.by) < self._max_sources:
                    existing.by.append(mutation_selector)
            self._map.move_to_end(key)
            return
        by = [mutation_selector] if mutation_selector else []
        self._map[key] = _StaleEntry(by=by, seq=seq, until=until)
        self._map.move_to_end(key)

    def _lookup_locked(
        self,
        concrete_selector: str,
        concrete_path: str,
        method: str,
        now: float,
    ) -> tuple[list[str], bool]:
        all_by: list[str] = []
        exact = self._map.get(concrete_selector)
        if exact is not None:
            if exact.until > now:
                all_by.extend(exact.by)
            else:
                del self._map[concrete_selector]
        expired: list[str] = []
        for key, entry in self._map.items():
            if entry.until <= now:
                expired.append(key)
                continue
            if "{" not in key and ":" not in key:
                continue
            if key == concrete_selector:
                continue
            key_method, key_pattern = self._split_key(key)
            if key_method != method:
                continue
            if path_matches_pattern(concrete_path, key_pattern):
                all_by.extend(entry.by)
        for key in expired:
            del self._map[key]
        deduped: list[str] = []
        seen: set[str] = set()
        for src in all_by:
            if src in seen:
                continue
            seen.add(src)
            deduped.append(src)
        return deduped, len(deduped) > 0

    def _evict_expired(self) -> None:
        now = _now()
        expired = [k for k, v in self._map.items() if now >= v.until]
        for k in expired:
            del self._map[k]

    def _enforce_capacity(self) -> None:
        if len(self._map) <= self._max_entries:
            return
        self._evict_expired()
        target = max(self._max_entries // 2, 1)
        while len(self._map) > target:
            self._map.popitem(last=False)

    @staticmethod
    def _split_key(key: str) -> tuple[str, str]:
        space_idx = key.find(" ")
        if space_idx == -1:
            return key, ""
        return key[:space_idx], key[space_idx + 1 :]


class _StaleTrackerSync:
    """Sync variant backed by ``threading.Lock``; mirrors :class:`_StaleTracker`."""

    def __init__(
        self,
        stale_time: float,
        stale_max_entries: int = 1000,
        max_sources_per_target: int = 16,
    ) -> None:
        """ stale_time == 0 disables the tracker (no stale window applied). """
        self._enabled = stale_time > 0
        self._stale_time = max(stale_time, 0.0)
        self._max_entries = max(stale_max_entries, 1)
        self._max_sources = max(max_sources_per_target, 1)
        self._map: OrderedDict[str, _StaleEntry] = OrderedDict()
        self._lock = threading.Lock()
        self._seq = 0

    @property
    def enabled(self) -> bool:
        return self._enabled

    def invalidate(self, patterns: list[str]) -> None:
        if not self._enabled:
            return
        with self._lock:
            self._evict_expired()
            targets = resolve_invalidation_targets(patterns, self._map)
            self._seq += 1
            until = _now() + self._stale_time
            for t in targets:
                self._upsert(t, until, self._seq, None)
            self._enforce_capacity()

    def mark_stale(
        self,
        invalidate: list[str],
        params: dict[str, str] | None,
        mutation_selector: str,
    ) -> None:
        if not self._enabled or not invalidate:
            return
        with self._lock:
            self._seq += 1
            until = _now() + self._stale_time
            resolved = resolve_invalidation_targets_for_mutation(invalidate, params)
            for target in resolved:
                self._upsert(target, until, self._seq, mutation_selector)
            self._enforce_capacity()

    def mark(self, key: str) -> None:
        if not self._enabled:
            return
        with self._lock:
            self._seq += 1
            until = _now() + self._stale_time
            self._upsert(key, until, self._seq, None)
            self._enforce_capacity()

    def is_stale(self, method_or_key: str, path: str | None = None) -> bool:
        if not self._enabled:
            return False
        if path is None:
            method, concrete_path = _StaleTracker._split_key(method_or_key)
        else:
            method, concrete_path = method_or_key, path
        with self._lock:
            _by, is_stale = self._lookup_locked(
                f"{method} {concrete_path}", concrete_path, method, _now(),
            )
            return is_stale

    def lookup_stale(
        self,
        concrete_selector: str,
        concrete_path: str,
        method: str,
    ) -> tuple[list[str], bool]:
        if not self._enabled:
            return [], False
        with self._lock:
            return self._lookup_locked(concrete_selector, concrete_path, method, _now())

    def clear_stale(
        self,
        concrete_selector: str,
        concrete_path: str,
        method: str,
        seq_snapshot: int,
    ) -> None:
        if not self._enabled:
            return
        with self._lock:
            exact = self._map.get(concrete_selector)
            if exact and exact.seq <= seq_snapshot:
                del self._map[concrete_selector]
            to_delete: list[str] = []
            for key, entry in self._map.items():
                if entry.seq > seq_snapshot:
                    continue
                key_method, key_pattern = _StaleTracker._split_key(key)
                if "{" not in key_pattern and ":" not in key_pattern:
                    continue
                if key_method != method:
                    continue
                if path_matches_pattern(concrete_path, key_pattern):
                    to_delete.append(key)
            for key in to_delete:
                del self._map[key]

    def build_request_meta(
        self,
        concrete_selector: str,
        concrete_path: str,
        method: str,
    ) -> _RequestMeta | None:
        if not self._enabled:
            return None
        with self._lock:
            by, is_stale = self._lookup_locked(
                concrete_selector, concrete_path, method, _now(),
            )
            return _RequestMeta(
                selector=concrete_selector,
                is_stale=is_stale,
                invalidated_by=by,
                seq_snapshot=self._seq,
            )

    def _upsert(
        self,
        key: str,
        until: float,
        seq: int,
        mutation_selector: str | None,
    ) -> None:
        existing = self._map.get(key)
        if existing is not None:
            existing.until = until
            existing.seq = seq
            if mutation_selector and mutation_selector not in existing.by:
                if len(existing.by) < self._max_sources:
                    existing.by.append(mutation_selector)
            self._map.move_to_end(key)
            return
        by = [mutation_selector] if mutation_selector else []
        self._map[key] = _StaleEntry(by=by, seq=seq, until=until)
        self._map.move_to_end(key)

    def _lookup_locked(
        self,
        concrete_selector: str,
        concrete_path: str,
        method: str,
        now: float,
    ) -> tuple[list[str], bool]:
        all_by: list[str] = []
        exact = self._map.get(concrete_selector)
        if exact is not None:
            if exact.until > now:
                all_by.extend(exact.by)
            else:
                del self._map[concrete_selector]
        expired: list[str] = []
        for key, entry in self._map.items():
            if entry.until <= now:
                expired.append(key)
                continue
            if "{" not in key and ":" not in key:
                continue
            if key == concrete_selector:
                continue
            key_method, key_pattern = _StaleTracker._split_key(key)
            if key_method != method:
                continue
            if path_matches_pattern(concrete_path, key_pattern):
                all_by.extend(entry.by)
        for key in expired:
            del self._map[key]
        deduped: list[str] = []
        seen: set[str] = set()
        for src in all_by:
            if src in seen:
                continue
            seen.add(src)
            deduped.append(src)
        return deduped, len(deduped) > 0

    def _evict_expired(self) -> None:
        now = _now()
        expired = [k for k, v in self._map.items() if now >= v.until]
        for k in expired:
            del self._map[k]

    def _enforce_capacity(self) -> None:
        if len(self._map) <= self._max_entries:
            return
        self._evict_expired()
        target = max(self._max_entries // 2, 1)
        while len(self._map) > target:
            self._map.popitem(last=False)


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
