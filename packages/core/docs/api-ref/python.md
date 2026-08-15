# Python API Reference

Generated from OpenAPI via the shared codegen IR. Do not edit by hand —
run `bun run public/honey/core/scripts/gen-api-ref.ts` to regenerate.

## Typed Errors

Every operation's error channel surfaces one of:

| Canonical             | Status | Lang symbol           | Notes                                                  |
| --------------------- | ------ | --------------------- | ------------------------------------------------------ |
| `BadRequest`          | 400    | `BadRequest`          | invalid request payload                                |
| `Unauthorized`        | 401    | `Unauthorized`        | missing/invalid auth; triggers onAuthExpired + 1 retry |
| `Forbidden`           | 403    | `Forbidden`           | authenticated but not permitted                        |
| `NotFound`            | 404    | `NotFound`            | resource does not exist                                |
| `Conflict`            | 409    | `Conflict`            | state conflict / unique violation                      |
| `UnprocessableEntity` | 422    | `UnprocessableEntity` | schema-valid but semantically rejected                 |
| `TooManyRequests`     | 429    | `TooManyRequests`     | rate-limited; consumer handles backoff via hooks       |
| `InternalServerError` | 500    | `InternalServerError` | server crash                                           |
| `BadGateway`          | 502    | `BadGateway`          | upstream failure                                       |
| `ServiceUnavailable`  | 503    | `ServiceUnavailable`  | server temporarily unavailable                         |
| `GatewayTimeout`      | 504    | `GatewayTimeout`      | upstream timeout                                       |
| `StatusError`         | *      | `StatusError`         | fallback for undeclared/other statuses                 |

Operations with declared `responses: { 4xx: { schema } }` parse the response body into the error's typed `data` field.

## Operations

### refresh_token

`POST /auth/refresh`

**Signature**

```
async def refresh_token(self, body: { refresh_token: str }) -> { access_token: str, expires_in: int }
```

**Request body**

- Content-type: `application/json`
- Required: yes
- Type: `{ refresh_token: str }`

**Responses**

| Status | Content-type       | Type                                     |
| ------ | ------------------ | ---------------------------------------- |
| `200`  | `application/json` | `{ access_token: str, expires_in: int }` |
| `401`  | `application/json` | `{ status: int, message: str }`          |

---

### get_declared_error

`GET /declared-errors/{status}`

**Signature**

```
async def get_declared_error(self, status: str) -> None
```

**Path params**

| Name     | Type  |
| -------- | ----- |
| `status` | `str` |

**Responses**

| Status    | Content-type       | Type                            |
| --------- | ------------------ | ------------------------------- |
| `400`     | `application/json` | `{ status: int, message: str }` |
| `404`     | `application/json` | `{ status: int, message: str }` |
| `default` | `application/json` | `{ status: int, message: str }` |

---

### get_error

`GET /errors/{status}`

**Signature**

```
async def get_error(self, status: int) -> None
```

**Path params**

| Name     | Type  |
| -------- | ----- |
| `status` | `int` |

**Responses**

| Status    | Content-type       | Type                            |
| --------- | ------------------ | ------------------------------- |
| `default` | `application/json` | `{ status: int, message: str }` |

---

### idempotent_create

`POST /idempotent-create`

**Signature**

```
async def idempotent_create(self) -> { idempotencyKey: str }
```

**Responses**

| Status | Content-type       | Type                      |
| ------ | ------------------ | ------------------------- |
| `200`  | `application/json` | `{ idempotencyKey: str }` |

**Extensions**

- `x-idempotency-key`: yes — auto-sent if omitted

---

### connect_realtime

`GET /realtime`

**Signature**

```
async def connect_realtime(self, reconnect_token: str) -> ResumableConnection
```

**Query params**

| Name              | Type  |
| ----------------- | ----- |
| `reconnect_token` | `str` |

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `101`  | `—`          | —    |

**Extensions**

- `x-realtime`: yes

---

### slow

`GET /slow`

**Signature**

```
async def slow(self, ms: int) -> { ok: bool }
```

**Query params**

| Name | Type  |
| ---- | ----- |
| `ms` | `int` |

**Responses**

| Status | Content-type       | Type           |
| ------ | ------------------ | -------------- |
| `200`  | `application/json` | `{ ok: bool }` |

---

### stream_events

`GET /stream`

**Signature**

```
async def stream_events(self, last_event_id: str) -> AsyncIterator[{ event: Optional[str], data: Optional[str], id: Optional[str] }]
```

**Header params**

| Name            | Type  |
| --------------- | ----- |
| `Last-Event-ID` | `str` |

**Responses**

| Status | Content-type        | Type                                                               |
| ------ | ------------------- | ------------------------------------------------------------------ |
| `200`  | `text/event-stream` | `{ event: Optional[str], data: Optional[str], id: Optional[str] }` |
| `401`  | `application/json`  | `{ status: int, message: str }`                                    |

**Extensions**

- SSE response detected (`text/event-stream`)

---

### upload_blob

`POST /upload`

**Signature**

```
async def upload_blob(self, body: AsyncIterator[bytes]) -> { size: int, hash: str }
```

**Request body**

- Content-type: `application/octet-stream`
- Required: yes
- Type: `AsyncIterator[bytes]`

**Responses**

| Status | Content-type       | Type                            |
| ------ | ------------------ | ------------------------------- |
| `200`  | `application/json` | `{ size: int, hash: str }`      |
| `401`  | `application/json` | `{ status: int, message: str }` |

---

### list_users

`GET /users`

**Signature**

```
async def list_users(self) -> { items: List[{ id: str, name: str, email: str }], total: int }
```

**Responses**

| Status | Content-type       | Type                                                              |
| ------ | ------------------ | ----------------------------------------------------------------- |
| `200`  | `application/json` | `{ items: List[{ id: str, name: str, email: str }], total: int }` |
| `401`  | `application/json` | `{ status: int, message: str }`                                   |

---

### create_user

`POST /users`

**Signature**

```
async def create_user(self, body: { name: str, email: str }) -> { id: str, name: str, email: str }
```

**Request body**

- Content-type: `application/json`
- Required: yes
- Type: `{ name: str, email: str }`

**Responses**

| Status | Content-type       | Type                                 |
| ------ | ------------------ | ------------------------------------ |
| `201`  | `application/json` | `{ id: str, name: str, email: str }` |
| `401`  | `application/json` | `{ status: int, message: str }`      |
| `422`  | `application/json` | `{ status: int, message: str }`      |

**Extensions**

- `x-invalidate`: `GET /users`

---

### delete_user

`DELETE /users/{id}`

**Signature**

```
async def delete_user(self, id: str) -> None
```

**Path params**

| Name | Type  |
| ---- | ----- |
| `id` | `str` |

**Responses**

| Status | Content-type       | Type                            |
| ------ | ------------------ | ------------------------------- |
| `204`  | `—`                | —                               |
| `401`  | `application/json` | `{ status: int, message: str }` |
| `404`  | `application/json` | `{ status: int, message: str }` |

**Extensions**

- `x-invalidate`: `GET /users`, `GET /users/{id}`

---

### get_user

`GET /users/{id}`

**Signature**

```
async def get_user(self, id: str) -> { id: str, name: str, email: str }
```

**Path params**

| Name | Type  |
| ---- | ----- |
| `id` | `str` |

**Responses**

| Status | Content-type       | Type                                 |
| ------ | ------------------ | ------------------------------------ |
| `200`  | `application/json` | `{ id: str, name: str, email: str }` |
| `401`  | `application/json` | `{ status: int, message: str }`      |
| `404`  | `application/json` | `{ status: int, message: str }`      |

---

### update_user

`PUT /users/{id}`

**Signature**

```
async def update_user(self, id: str, body: { name: Optional[str], email: Optional[str] }) -> { id: str, name: str, email: str }
```

**Path params**

| Name | Type  |
| ---- | ----- |
| `id` | `str` |

**Request body**

- Content-type: `application/json`
- Required: yes
- Type: `{ name: Optional[str], email: Optional[str] }`

**Responses**

| Status | Content-type       | Type                                 |
| ------ | ------------------ | ------------------------------------ |
| `200`  | `application/json` | `{ id: str, name: str, email: str }` |
| `401`  | `application/json` | `{ status: int, message: str }`      |
| `404`  | `application/json` | `{ status: int, message: str }`      |

**Extensions**

- `x-invalidate`: `GET /users`, `GET /users/{id}`

---

### connect_ws

`GET /ws`

**Signature**

```
async def connect_ws(self, token: str) -> ResumableConnection
```

**Query params**

| Name    | Type  |
| ------- | ----- |
| `token` | `str` |

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `101`  | `—`          | —    |

**Extensions**

- `x-websocket`: yes

---
