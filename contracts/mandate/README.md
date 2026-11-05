# termwork_mandate

NEAR mandate contract. Tests run on Linux, macOS or WSL only (the near-sandbox binary is not available for native Windows).

```bash
rustup target add wasm32-unknown-unknown   # once
cargo install cargo-near                   # once
cargo test                                 # unit tests + sandbox lifecycle tests
```

`cargo test --test lifecycle` runs `cargo near build non-reproducible-wasm` itself (output in `target/near/`), so it always tests the current source. Plain `cargo build` wasm drops panic messages, hence cargo-near. It downloads the near-sandbox binary on first run and runs the contract against the real Sputnik DAO wasm in `tests/res/` (see `tests/res/README.md`).

To produce the deployable wasm: `cargo near build non-reproducible-wasm`.

WSL tip: when the project lives under `/mnt/...`, builds are very slow. Set `CARGO_TARGET_DIR=$HOME/tw-target` before `cargo test` to build on the Linux filesystem.
