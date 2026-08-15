# Go API Reference

Generated from OpenAPI via the shared codegen IR. Do not edit by hand —
run `bun run public/honey/core/scripts/gen-api-ref.ts` to regenerate.

## Typed Errors

Every operation's error channel surfaces one of:

| Canonical | Status | Lang symbol | Notes |
| --------- | ------ | ----------- | ----- |
| `BadRequest` | 400 | `ErrBadRequest` | invalid request payload |
| `Unauthorized` | 401 | `ErrUnauthorized` | missing/invalid auth; triggers onAuthExpired + 1 retry |
| `Forbidden` | 403 | `ErrForbidden` | authenticated but not permitted |
| `NotFound` | 404 | `ErrNotFound` | resource does not exist |
| `Conflict` | 409 | `ErrConflict` | state conflict / unique violation |
| `UnprocessableEntity` | 422 | `ErrUnprocessableEntity` | schema-valid but semantically rejected |
| `TooManyRequests` | 429 | `ErrTooManyRequests` | rate-limited; consumer handles backoff via hooks |
| `InternalServerError` | 500 | `ErrInternalServerError` | server crash |
| `BadGateway` | 502 | `ErrBadGateway` | upstream failure |
| `ServiceUnavailable` | 503 | `ErrServiceUnavailable` | server temporarily unavailable |
| `GatewayTimeout` | 504 | `ErrGatewayTimeout` | upstream timeout |
| `StatusError` | * | `ErrStatusError` | fallback for undeclared/other statuses |

Operations with declared `responses: { 4xx: { schema } }` parse the response body into the error's typed `data` field.

## Operations

### RefreshToken

`POST /auth/refresh`

**Signature**

```
func (c *Client) RefreshToken(ctx context.Context, body struct { RefreshToken string }) (struct { AccessToken string; ExpiresIn int }, error)
```

**Request body**

- Content-type: `application/json`
- Required: yes
- Type: `struct { RefreshToken string }`

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `200` | `application/json` | `struct { AccessToken string; ExpiresIn int }` |
| `401` | `application/json` | `struct { Status int; Message string }` |

---

### GetDeclaredError

`GET /declared-errors/{status}`

**Signature**

```
func (c *Client) GetDeclaredError(ctx context.Context, Status string) (struct{}, error)
```

**Path params**

| Name | Type |
| ---- | ---- |
| `status` | `string` |

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `400` | `application/json` | `struct { Status int; Message string }` |
| `404` | `application/json` | `struct { Status int; Message string }` |
| `default` | `application/json` | `struct { Status int; Message string }` |

---

### GetError

`GET /errors/{status}`

**Signature**

```
func (c *Client) GetError(ctx context.Context, Status int) (struct{}, error)
```

**Path params**

| Name | Type |
| ---- | ---- |
| `status` | `int` |

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `default` | `application/json` | `struct { Status int; Message string }` |

---

### IdempotentCreate

`POST /idempotent-create`

**Signature**

```
func (c *Client) IdempotentCreate(ctx context.Context) (struct { IdempotencyKey string }, error)
```

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `200` | `application/json` | `struct { IdempotencyKey string }` |

**Extensions**

- `x-idempotency-key`: yes — auto-sent if omitted

---

### ConnectRealtime

`GET /realtime`

**Signature**

```
func (c *Client) ConnectRealtime(ctx context.Context, ReconnectToken string) (*ResumableConnection, error)
```

**Query params**

| Name | Type |
| ---- | ---- |
| `reconnect_token` | `string` |

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `101` | `—` | — |

**Extensions**

- `x-realtime`: yes

---

### Slow

`GET /slow`

**Signature**

```
func (c *Client) Slow(ctx context.Context, Ms int) (struct { Ok bool }, error)
```

**Query params**

| Name | Type |
| ---- | ---- |
| `ms` | `int` |

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `200` | `application/json` | `struct { Ok bool }` |

---

### StreamEvents

`GET /stream`

**Signature**

```
func (c *Client) StreamEvents(ctx context.Context, LastEventID string) (<-chan struct { Event *string; Data *string; Id *string }, error)
```

**Header params**

| Name | Type |
| ---- | ---- |
| `Last-Event-ID` | `string` |

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `200` | `text/event-stream` | `struct { Event *string; Data *string; Id *string }` |
| `401` | `application/json` | `struct { Status int; Message string }` |

**Extensions**

- SSE response detected (`text/event-stream`)

---

### UploadBlob

`POST /upload`

**Signature**

```
func (c *Client) UploadBlob(ctx context.Context, body io.Reader) (struct { Size int; Hash string }, error)
```

**Request body**

- Content-type: `application/octet-stream`
- Required: yes
- Type: `io.Reader`

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `200` | `application/json` | `struct { Size int; Hash string }` |
| `401` | `application/json` | `struct { Status int; Message string }` |

---

### ListUsers

`GET /users`

**Signature**

```
func (c *Client) ListUsers(ctx context.Context) (struct { Items []struct { Id string; Name string; Email string }; Total int }, error)
```

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `200` | `application/json` | `struct { Items []struct { Id string; Name string; Email string }; Total int }` |
| `401` | `application/json` | `struct { Status int; Message string }` |

---

### CreateUser

`POST /users`

**Signature**

```
func (c *Client) CreateUser(ctx context.Context, body struct { Name string; Email string }) (struct { Id string; Name string; Email string }, error)
```

**Request body**

- Content-type: `application/json`
- Required: yes
- Type: `struct { Name string; Email string }`

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `201` | `application/json` | `struct { Id string; Name string; Email string }` |
| `401` | `application/json` | `struct { Status int; Message string }` |
| `422` | `application/json` | `struct { Status int; Message string }` |

**Extensions**

- `x-invalidate`: `GET /users`

---

### DeleteUser

`DELETE /users/{id}`

**Signature**

```
func (c *Client) DeleteUser(ctx context.Context, Id string) (struct{}, error)
```

**Path params**

| Name | Type |
| ---- | ---- |
| `id` | `string` |

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `204` | `—` | — |
| `401` | `application/json` | `struct { Status int; Message string }` |
| `404` | `application/json` | `struct { Status int; Message string }` |

**Extensions**

- `x-invalidate`: `GET /users`, `GET /users/{id}`

---

### GetUser

`GET /users/{id}`

**Signature**

```
func (c *Client) GetUser(ctx context.Context, Id string) (struct { Id string; Name string; Email string }, error)
```

**Path params**

| Name | Type |
| ---- | ---- |
| `id` | `string` |

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `200` | `application/json` | `struct { Id string; Name string; Email string }` |
| `401` | `application/json` | `struct { Status int; Message string }` |
| `404` | `application/json` | `struct { Status int; Message string }` |

---

### UpdateUser

`PUT /users/{id}`

**Signature**

```
func (c *Client) UpdateUser(ctx context.Context, Id string, body struct { Name *string; Email *string }) (struct { Id string; Name string; Email string }, error)
```

**Path params**

| Name | Type |
| ---- | ---- |
| `id` | `string` |

**Request body**

- Content-type: `application/json`
- Required: yes
- Type: `struct { Name *string; Email *string }`

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `200` | `application/json` | `struct { Id string; Name string; Email string }` |
| `401` | `application/json` | `struct { Status int; Message string }` |
| `404` | `application/json` | `struct { Status int; Message string }` |

**Extensions**

- `x-invalidate`: `GET /users`, `GET /users/{id}`

---

### ConnectWs

`GET /ws`

**Signature**

```
func (c *Client) ConnectWs(ctx context.Context, Token string) (*ResumableConnection, error)
```

**Query params**

| Name | Type |
| ---- | ---- |
| `token` | `string` |

**Responses**

| Status | Content-type | Type |
| ------ | ------------ | ---- |
| `101` | `—` | — |

**Extensions**

- `x-websocket`: yes

---
