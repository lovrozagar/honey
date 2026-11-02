# dx — user agent

A coarse read of a `User-Agent` header for session lists and new-device checks. A function at `./user-agent`, not `ctx.userAgent`: most requests never read it.

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `parseUserAgent(header)` | — | `null` and `undefined` read as unknown | `{ browser, browserMajor, deviceType, os, osVersion }`; a bot is `"bot"` with nulls | client-written, so never an access decision; Safari on an iPad reads as macOS desktop | `context/user-agent.test.ts` |
| first 512 characters | — | not configurable | nothing past them is scanned, in time linear to them | — | `security/request-adversarial.test.ts` |
| `browserMajor` | — | — | `null` past `Number.MAX_SAFE_INTEGER`, keeping the browser | — | `context/user-agent.test.ts` |
