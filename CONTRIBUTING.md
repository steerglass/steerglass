# Contributing to Steerglass

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and ideas

Open an [issue](https://github.com/steerglass/steerglass/issues). In the app, Help → Send feedback
(or Report a Bug… in the macOS menu) opens one with your version and system filled in. For bugs,
say what you did, what you expected and what happened; a screenshot helps. Leave out anything
private: cluster names, addresses, tokens and the content of Secrets.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Development

Requirements: Rust (stable), Node 22+, pnpm. On Linux, the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
(WebKitGTK and friends).

```sh
pnpm install
pnpm tauri dev                                          # the app, with hot reload
```

Before sending a pull request:

```sh
pnpm exec tsc --noEmit                                  # types
pnpm test                                               # frontend tests
cargo test --manifest-path src-tauri/Cargo.toml --lib   # Rust tests
cargo clippy --manifest-path src-tauri/Cargo.toml       # Rust lints
```

Some Rust tests talk to a real cluster and only read from it; they are skipped unless you ask for them:

```sh
KC_TEST_CONTEXT=my-context cargo test --manifest-path src-tauri/Cargo.toml --lib live -- --ignored --nocapture
```

Test against a cluster you own — kind, k3d or minikube are perfect — never against production.

The README has a short tour of the code, under *Architecture*.

## Pull requests

- Keep each pull request to one change, and explain the why in the description.
- For a bigger change or a new feature, open an issue first so we can agree on the approach.
- Match the style around you; user-facing text is plain English, short and concrete.
- Speed matters: tables stream compact rows computed in Rust, never full objects. Keep it that way.
- Safety matters: anything that changes a cluster must go through the existing confirmations for
  production contexts.

By submitting a contribution you agree that it is licensed under the Apache License 2.0, like the rest
of the project (see section 5 of the [LICENSE](LICENSE)).
