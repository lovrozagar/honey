# Rust API Reference

Generated from OpenAPI via the shared codegen IR. Do not edit by hand —
run `bun run public/honey/core/scripts/gen-api-ref.ts` to regenerate.

## Typed Errors

Every operation's error channel surfaces one of:

| Canonical             | Status | Lang symbol                  | Notes                                                  |
| --------------------- | ------ | ---------------------------- | ------------------------------------------------------ |
| `BadRequest`          | 400    | `Error::BadRequest`          | invalid request payload                                |
| `Unauthorized`        | 401    | `Error::Unauthorized`        | missing/invalid auth; triggers onAuthExpired + 1 retry |
| `Forbidden`           | 403    | `Error::Forbidden`           | authenticated but not permitted                        |
| `NotFound`            | 404    | `Error::NotFound`            | resource does not exist                                |
| `Conflict`            | 409    | `Error::Conflict`            | state conflict / unique violation                      |
| `UnprocessableEntity` | 422    | `Error::UnprocessableEntity` | schema-valid but semantically rejected                 |
| `TooManyRequests`     | 429    | `Error::TooManyRequests`     | rate-limited; consumer handles backoff via hooks       |
| `InternalServerError` | 500    | `Error::InternalServerError` | server crash                                           |
| `BadGateway`          | 502    | `Error::BadGateway`          | upstream failure                                       |
| `ServiceUnavailable`  | 503    | `Error::ServiceUnavailable`  | server temporarily unavailable                         |
| `GatewayTimeout`      | 504    | `Error::GatewayTimeout`      | upstream timeout                                       |
| `StatusError`         | *      | `Error::StatusError`         | fallback for undeclared/other statuses                 |

Operations with declared `responses: { 4xx: { schema } }` parse the response body into the error's typed `data` field.

## Operations

### refresh_token

`POST /auth/refresh`

**Signature**

```
pub async fn refresh_token(&self, body: struct { refresh_token: String }) -> Result<struct { access_token: String, expires_in: i64 }, Error>
```

**Request body**

- Content-type: `application/json`
- Required: yes
- Type: `struct { refresh_token: String }`

**Responses**

| Status | Content-type       | Type                                               |
| ------ | ------------------ | -------------------------------------------------- |
| `200`  | `application/json` | `struct { access_token: String, expires_in: i64 }` |
| `401`  | `application/json` | `struct { status: i64, message: String }`          |

---

### get_declared_error

`GET /declared-errors/{status}`

**Signature**

```
pub async fn get_declared_error(&self, status: String) -> Result<(), Error>
```

**Path params**

| Name     | Type     |
| -------- | -------- |
| `status` | `String` |

**Responses**

| Status    | Content-type       | Type                                      |
| --------- | ------------------ | ----------------------------------------- |
| `400`     | `application/json` | `struct { status: i64, message: String }` |
| `404`     | `application/json` | `struct { status: i64, message: String }` |
| `default` | `application/json` | `struct { status: i64, message: String }` |

---

### get_error

`GET /errors/{status}`

**Signature**

```
pub async fn get_error(&self, status: i64) -> Result<(), Error>
```

**Path params**

| Name     | Type  |
| -------- | ----- |
| `status` | `i64` |

**Responses**

| Status    | Content-type       | Type                                      |
| --------- | ------------------ | ----------------------------------------- |
| `default` | `application/json` | `struct { status: i64, message: String }` |

---

### idempotent_create

`POST /idempotent-create`

**Signature**

```
pub async fn idempotent_create(&self) -> Result<struct { idempotency_key: String }, Error>
```

**Responses**

| Status | Content-type       | Type                                 |
| ------ | ------------------ | ------------------------------------ |
| `200`  | `application/json` | `struct { idempotency_key: String }` |

**Extensions**

- `x-idempotency-key`: yes — auto-sent if omitted

---

### connect_realtime

`GET /realtime`

**Signature**

```
pub async fn connect_realtime(&self, reconnect_token: String) -> Result<ResumableConnection, Error>
```

**Query params**

| Name              | Type     |
| ----------------- | -------- |
| `reconnect_token` | `String` |

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
pub async fn slow(&self, ms: i64) -> Result<struct { ok: bool }, Error>
```

**Query params**

| Name | Type  |
| ---- | ----- |
| `ms` | `i64` |

**Responses**

| Status | Content-type       | Type                  |
| ------ | ------------------ | --------------------- |
| `200`  | `application/json` | `struct { ok: bool }` |

---

### stream_events

`GET /stream`

**Signature**

```
pub async fn stream_events(&self, last_event_id: String) -> Result<impl Stream<Item = struct { event: Option<String>, data: Option<String>, id: Option<String> }>, Error>
```

**Header params**

| Name            | Type     |
| --------------- | -------- |
| `Last-Event-ID` | `String` |

**Responses**

| Status | Content-type        | Type                                                                         |
| ------ | ------------------- | ---------------------------------------------------------------------------- |
| `200`  | `text/event-stream` | `struct { event: Option<String>, data: Option<String>, id: Option<String> }` |
| `401`  | `application/json`  | `struct { status: i64, message: String }`                                    |

**Extensions**

- SSE response detected (`text/event-stream`)

---

### upload_blob

`POST /upload`

**Signature**

```
pub async fn upload_blob(&self, body: impl Stream<Item = Bytes>) -> Result<struct { size: i64, hash: String }, Error>
```

**Request body**

- Content-type: `application/octet-stream`
- Required: yes
- Type: `impl Stream<Item = Bytes>`

**Responses**

| Status | Content-type       | Type                                      |
| ------ | ------------------ | ----------------------------------------- |
| `200`  | `application/json` | `struct { size: i64, hash: String }`      |
| `401`  | `application/json` | `struct { status: i64, message: String }` |

---

### list_users

`GET /users`

**Signature**

```
pub async fn list_users(&self) -> Result<struct { items: Vec<struct { id: String, name: String, email: String }>, total: i64 }, Error>
```

**Responses**

| Status | Content-type       | Type                                                                                    |
| ------ | ------------------ | --------------------------------------------------------------------------------------- |
| `200`  | `application/json` | `struct { items: Vec<struct { id: String, name: String, email: String }>, total: i64 }` |
| `401`  | `application/json` | `struct { status: i64, message: String }`                                               |

---

### create_user

`POST /users`

**Signature**

```
pub async fn create_user(&self, body: struct { name: String, email: String }) -> Result<struct { id: String, name: String, email: String }, Error>
```

**Request body**

- Content-type: `application/json`
- Required: yes
- Type: `struct { name: String, email: String }`

**Responses**

| Status | Content-type       | Type                                                 |
| ------ | ------------------ | ---------------------------------------------------- |
| `201`  | `application/json` | `struct { id: String, name: String, email: String }` |
| `401`  | `application/json` | `struct { status: i64, message: String }`            |
| `422`  | `application/json` | `struct { status: i64, message: String }`            |

**Extensions**

- `x-invalidate`: `GET /users`

---

### delete_user

`DELETE /users/{id}`

**Signature**

```
pub async fn delete_user(&self, id: String) -> Result<(), Error>
```

**Path params**

| Name | Type     |
| ---- | -------- |
| `id` | `String` |

**Responses**

| Status | Content-type       | Type                                      |
| ------ | ------------------ | ----------------------------------------- |
| `204`  | `—`                | —                                         |
| `401`  | `application/json` | `struct { status: i64, message: String }` |
| `404`  | `application/json` | `struct { status: i64, message: String }` |

**Extensions**

- `x-invalidate`: `GET /users`, `GET /users/{id}`

---

### get_user

`GET /users/{id}`

**Signature**

```
pub async fn get_user(&self, id: String) -> Result<struct { id: String, name: String, email: String }, Error>
```

**Path params**

| Name | Type     |
| ---- | -------- |
| `id` | `String` |

**Responses**

| Status | Content-type       | Type                                                 |
| ------ | ------------------ | ---------------------------------------------------- |
| `200`  | `application/json` | `struct { id: String, name: String, email: String }` |
| `401`  | `application/json` | `struct { status: i64, message: String }`            |
| `404`  | `application/json` | `struct { status: i64, message: String }`            |

---

### update_user

`PUT /users/{id}`

**Signature**

```
pub async fn update_user(&self, id: String, body: struct { name: Option<String>, email: Option<String> }) -> Result<struct { id: String, name: String, email: String }, Error>
```

**Path params**

| Name | Type     |
| ---- | -------- |
| `id` | `String` |

**Request body**

- Content-type: `application/json`
- Required: yes
- Type: `struct { name: Option<String>, email: Option<String> }`

**Responses**

| Status | Content-type       | Type                                                 |
| ------ | ------------------ | ---------------------------------------------------- |
| `200`  | `application/json` | `struct { id: String, name: String, email: String }` |
| `401`  | `application/json` | `struct { status: i64, message: String }`            |
| `404`  | `application/json` | `struct { status: i64, message: String }`            |

**Extensions**

- `x-invalidate`: `GET /users`, `GET /users/{id}`

---

### connect_ws

`GET /ws`

**Signature**

```
pub async fn connect_ws(&self, token: String) -> Result<ResumableConnection, Error>
```

**Query params**

| Name    | Type     |
| ------- | -------- |
| `token` | `String` |

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `101`  | `—`          | —    |

**Extensions**

- `x-websocket`: yes

---
