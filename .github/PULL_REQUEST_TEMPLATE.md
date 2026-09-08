**What this changes**

<!-- One or two sentences. Link the issue if one exists. -->

**How it was verified**

<!-- Which of the real gates ran green: -->

- [ ] `npm test && npm run typecheck && npm run lint` (engine)
- [ ] `npm run test:package` (packaged server and stdio integration)
- [ ] `cd gui && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings` (GUI)
- [ ] `cargo test -p mtg-edh-mcp-client --test round_trip -- --ignored` (wire round-trips; needs `npm run build` first)
- [ ] Not applicable (docs only)

**Notes for the reviewer**

<!-- Tradeoffs, deliberate scope cuts, anything you'd flag. -->
