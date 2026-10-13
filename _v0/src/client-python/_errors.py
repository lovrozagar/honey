from __future__ import annotations

from typing import Any

import httpx


class APIError(Exception):
    """Base class for all API errors."""

    status: int
    body: Any
    data: Any
    response: httpx.Response
    message: str

    def __init__(
        self,
        *,
        status: int,
        body: Any,
        data: Any,
        response: httpx.Response,
        message: str,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.body = body
        self.data = data
        self.response = response
        self.message = message

    def __repr__(self) -> str:
        cls = self.__class__.__name__
        return f"{cls}(status={self.status}, message={self.message!r})"


class BadRequestError(APIError):
    """HTTP 400 Bad Request."""


class UnauthorizedError(APIError):
    """HTTP 401 Unauthorized."""


class ForbiddenError(APIError):
    """HTTP 403 Forbidden."""


class NotFoundError(APIError):
    """HTTP 404 Not Found."""


class ConflictError(APIError):
    """HTTP 409 Conflict."""


class UnprocessableEntityError(APIError):
    """HTTP 422 Unprocessable Entity."""


class RateLimitError(APIError):
    """HTTP 429 Too Many Requests."""


class InternalServerError(APIError):
    """HTTP 500 Internal Server Error."""


class BadGatewayError(APIError):
    """HTTP 502 Bad Gateway."""


class ServiceUnavailableError(APIError):
    """HTTP 503 Service Unavailable."""


class GatewayTimeoutError(APIError):
    """HTTP 504 Gateway Timeout."""


class APIStatusError(APIError):
    """Fallback for any 4xx/5xx status not covered by a named subclass."""


_STATUS_ERROR_MAP: dict[int, type[APIError]] = {
    400: BadRequestError,
    401: UnauthorizedError,
    403: ForbiddenError,
    404: NotFoundError,
    409: ConflictError,
    422: UnprocessableEntityError,
    429: RateLimitError,
    500: InternalServerError,
    502: BadGatewayError,
    503: ServiceUnavailableError,
    504: GatewayTimeoutError,
}

__all__ = [
    "APIError",
    "APIStatusError",
    "BadGatewayError",
    "BadRequestError",
    "ConflictError",
    "ForbiddenError",
    "GatewayTimeoutError",
    "InternalServerError",
    "NotFoundError",
    "RateLimitError",
    "ServiceUnavailableError",
    "UnauthorizedError",
    "UnprocessableEntityError",
    "_STATUS_ERROR_MAP",
]
