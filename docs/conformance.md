# SDK conformance

Every generated target (TypeScript, Go, Rust, Python, C#, Java, the CLI and MCP) runs one shared scenario
suite against a live reference server, and each answer and each request on the wire must match one expected table.
A feature that works in one SDK and breaks in another fails the grid, so the targets behave alike. Where a target
cannot do something, the grid records it as a named lack, never a silent gap.

## Example

```text
feature × target: ts go rust python csharp java cli mcp
each cell: the decoded answer and the wire request, against one expected table
```
