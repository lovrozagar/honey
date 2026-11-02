# User agent

`@lovrozagar/honey/user-agent` reads a `User-Agent` header into a coarse browser, OS and device, for a session list or a
new-device check. It is a function, not a `ctx` field: only the routes that want it pay for it.

## Example

```ts run
import { parseUserAgent } from "@lovrozagar/honey/user-agent"

const header = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36"

const { browser, browserMajor, deviceType, os } = parseUserAgent(header)

console.log(browser, browserMajor, os, deviceType)
// prints: Chrome 141 Windows desktop
```

In a handler, pass it `ctx.req.headers.get("user-agent")`. A missing header is fine and reads as unknown.

## What it answers

| field          | value                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------- |
| `browser`      | `Edge`, `Opera`, `Samsung Internet`, `Firefox`, `Chrome`, `Safari`, or `null`             |
| `browserMajor` | the major version, or `null` when it is missing or past `Number.MAX_SAFE_INTEGER`         |
| `deviceType`   | `bot`, `desktop`, `mobile`, `tablet`, or `unknown`                                        |
| `os`           | `iPadOS`, `iOS`, `Android`, `Windows`, `macOS`, `ChromeOS`, `Linux`, or `null`            |
| `osVersion`    | dotted text such as `18.6`, or `null` when the header carries none; Windows 11 reads `10` |

A bot answers `deviceType: "bot"` and nulls. Device models and engine versions are left out on purpose.

## What it cannot tell you

The header is whatever the client sent, so never use it to decide access. Show it to people, or compare it to spot a new
device.

Safari on an iPad sends a Mac header by default, so it reads as macOS desktop. The header alone cannot tell the two apart.

Only the first 512 characters are read, and every pattern runs in time linear to those, so a hostile header costs nothing
extra.
