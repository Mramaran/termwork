# Prebuilt mandate wasm

`termwork_mandate.wasm` is the mandate contract built from `contracts/mandate/src`, committed so the demo and `npm run -w scripts deploy` work without a Rust toolchain.

- Size: 221071 bytes
- sha256: `1a928611d5213123589159e7efcf8df3e0b1fbaeda8681bf9826be53e84e6c50`
- Build command: `cd contracts/mandate && cargo near build non-reproducible-wasm` (cargo-near 0.22.0, stable Rust, target `wasm32-unknown-unknown`), then copy `target/near/termwork_mandate.wasm` here.

`scripts/src/deploy.ts` uses `target/near/termwork_mandate.wasm` when it exists and this file otherwise, and logs which one it picked. The build is not reproducible byte for byte, so a hash from your own build can differ; check this file with `sha256sum`.
