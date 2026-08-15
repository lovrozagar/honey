## Lessons

### Integration tests belong in consumer packages, not in core

- **Pattern**: When testing a plugin/library feature end-to-end with a real app, put the test in the consumer package (e.g. `demo/`), not in core's test suite
- **Why**: Cross-repo test imports (`../../../../demo/src/app.ts`) are fragile and test from the wrong perspective. Consumer tests import via the package name (`honey/plugin`) — exactly how real users would
- **Date**: 2026-03-13
