# Contributing

```sh
bun install
bun run dev        # local Worker on http://localhost:8787
bun run test       # Vitest on the Workers runtime. Not `bun test`.
bun run typecheck
```

- `SPEC.md` is the contract. Change the spec and the tests in the same PR as the code.
- Zero runtime dependencies. The Worker imports nothing but `cloudflare:*` modules. Keep it that way.
- Every endpoint must work from a bare URL with no headers. GET writes are the primary path, never the second-class one.
- Nothing may store, log or show an IP address.
- Invented values only in examples, tests and docs. No real dataset content, no personal data.
- Use bun, not npm. Commit `bun.lock`; CI installs with `--frozen-lockfile`.
- PRs welcome. Small and focused beats large. Say what changed and why in plain words.
- Something broken? Open an issue. The maintainer fixes bugs; you do not have to.
