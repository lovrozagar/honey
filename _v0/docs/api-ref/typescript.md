# TypeScript API Reference

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

### refreshToken

`POST /auth/refresh`

**Signature**

```
refreshToken(body: { refresh_token: string }): Promise<{ access_token: string; expires_in: number }>
```

**Request body**

- Content-type: `application/json`
- Required: yes
- Type: `{ refresh_token: string }`

**Responses**

| Status | Content-type       | Type                                           |
| ------ | ------------------ | ---------------------------------------------- |
| `200`  | `application/json` | `{ access_token: string; expires_in: number }` |
| `401`  | `application/json` | `{ status: number; message: string }`          |

---

### getDeclaredError

`GET /declared-errors/{status}`

**Signature**

```
getDeclaredError(status: string): Promise<void>
```

**Path params**

| Name     | Type     |
| -------- | -------- |
| `status` | `string` |

**Responses**

| Status    | Content-type       | Type                                  |
| --------- | ------------------ | ------------------------------------- |
| `400`     | `application/json` | `{ status: number; message: string }` |
| `404`     | `application/json` | `{ status: number; message: string }` |
| `default` | `application/json` | `{ status: number; message: string }` |

---

### getError

`GET /errors/{status}`

**Signature**

```
getError(status: number): Promise<void>
```

**Path params**

| Name     | Type     |
| -------- | -------- |
| `status` | `number` |

**Responses**

| Status    | Content-type       | Type                                  |
| --------- | ------------------ | ------------------------------------- |
| `default` | `application/json` | `{ status: number; message: string }` |

---

### idempotentCreate

`POST /idempotent-create`

**Signature**

```
idempotentCreate(): Promise<{ idempotencyKey: string }>
```

**Responses**

| Status | Content-type       | Type                         |
| ------ | ------------------ | ---------------------------- |
| `200`  | `application/json` | `{ idempotencyKey: string }` |

**Extensions**

- `x-idempotency-key`: yes — auto-sent if omitted

---

### connectRealtime

`GET /realtime`

**Signature**

```
connectRealtime(reconnect_token: string): ResumableConnection
```

**Query params**

| Name              | Type     |
| ----------------- | -------- |
| `reconnect_token` | `string` |

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
slow(ms: number): Promise<{ ok: boolean }>
```

**Query params**

| Name | Type     |
| ---- | -------- |
| `ms` | `number` |

**Responses**

| Status | Content-type       | Type              |
| ------ | ------------------ | ----------------- |
| `200`  | `application/json` | `{ ok: boolean }` |

---

### streamEvents

`GET /stream`

**Signature**

```
streamEvents(Last-Event-ID: string): AsyncIterable<{ event?: string; data?: string; id?: string }>
```

**Header params**

| Name            | Type     |
| --------------- | -------- |
| `Last-Event-ID` | `string` |

**Responses**

| Status | Content-type        | Type                                             |
| ------ | ------------------- | ------------------------------------------------ |
| `200`  | `text/event-stream` | `{ event?: string; data?: string; id?: string }` |
| `401`  | `application/json`  | `{ status: number; message: string }`            |

**Extensions**

- SSE response detected (`text/event-stream`)

---

### uploadBlob

`POST /upload`

**Signature**

```
uploadBlob(body: ReadableStream | Blob): Promise<{ size: number; hash: string }>
```

**Request body**

- Content-type: `application/octet-stream`
- Required: yes
- Type: `ReadableStream | Blob`

**Responses**

| Status | Content-type       | Type                                  |
| ------ | ------------------ | ------------------------------------- |
| `200`  | `application/json` | `{ size: number; hash: string }`      |
| `401`  | `application/json` | `{ status: number; message: string }` |

---

### listUsers

`GET /users`

**Signature**

```
listUsers(): Promise<{ items: { id: string; name: string; email: string }[]; total: number }>
```

**Responses**

| Status | Content-type       | Type                                                                      |
| ------ | ------------------ | ------------------------------------------------------------------------- |
| `200`  | `application/json` | `{ items: { id: string; name: string; email: string }[]; total: number }` |
| `401`  | `application/json` | `{ status: number; message: string }`                                     |

---

### createUser

`POST /users`

**Signature**

```
createUser(body: { name: string; email: string }): Promise<{ id: string; name: string; email: string }>
```

**Request body**

- Content-type: `application/json`
- Required: yes
- Type: `{ name: string; email: string }`

**Responses**

| Status | Content-type       | Type                                          |
| ------ | ------------------ | --------------------------------------------- |
| `201`  | `application/json` | `{ id: string; name: string; email: string }` |
| `401`  | `application/json` | `{ status: number; message: string }`         |
| `422`  | `application/json` | `{ status: number; message: string }`         |

**Extensions**

- `x-invalidate`: `GET /users`

---

### deleteUser

`DELETE /users/{id}`

**Signature**

```
deleteUser(id: string): Promise<void>
```

**Path params**

| Name | Type     |
| ---- | -------- |
| `id` | `string` |

**Responses**

| Status | Content-type       | Type                                  |
| ------ | ------------------ | ------------------------------------- |
| `204`  | `—`                | —                                     |
| `401`  | `application/json` | `{ status: number; message: string }` |
| `404`  | `application/json` | `{ status: number; message: string }` |

**Extensions**

- `x-invalidate`: `GET /users`, `GET /users/{id}`

---

### getUser

`GET /users/{id}`

**Signature**

```
getUser(id: string): Promise<{ id: string; name: string; email: string }>
```

**Path params**

| Name | Type     |
| ---- | -------- |
| `id` | `string` |

**Responses**

| Status | Content-type       | Type                                          |
| ------ | ------------------ | --------------------------------------------- |
| `200`  | `application/json` | `{ id: string; name: string; email: string }` |
| `401`  | `application/json` | `{ status: number; message: string }`         |
| `404`  | `application/json` | `{ status: number; message: string }`         |

---

### updateUser

`PUT /users/{id}`

**Signature**

```
updateUser(id: string, body: { name?: string; email?: string }): Promise<{ id: string; name: string; email: string }>
```

**Path params**

| Name | Type     |
| ---- | -------- |
| `id` | `string` |

**Request body**

- Content-type: `application/json`
- Required: yes
- Type: `{ name?: string; email?: string }`

**Responses**

| Status | Content-type       | Type                                          |
| ------ | ------------------ | --------------------------------------------- |
| `200`  | `application/json` | `{ id: string; name: string; email: string }` |
| `401`  | `application/json` | `{ status: number; message: string }`         |
| `404`  | `application/json` | `{ status: number; message: string }`         |

**Extensions**

- `x-invalidate`: `GET /users`, `GET /users/{id}`

---

### connectWs

`GET /ws`

**Signature**

```
connectWs(token: string): ResumableConnection
```

**Query params**

| Name    | Type     |
| ------- | -------- |
| `token` | `string` |

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `101`  | `—`          | —    |

**Extensions**

- `x-websocket`: yes

---
