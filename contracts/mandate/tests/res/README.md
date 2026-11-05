# Test resources

## sputnikdao2.wasm

The Sputnik DAO v2 contract code that the testnet factory `sputnikv2.testnet`
deploys by default (factory version entry `[3, 31]`, commit
`7764926cfd3c47f62b5fcde231c251f3c3892887`).

- Source: `get_code({"code_hash": "AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH"})`
  on `sputnikv2.testnet`, where that hash is the result of `get_default_code_hash`
  (fetched through the testnet RPC, `call_function`).
- Size: 539647 bytes
- sha256 (hex): `880bae9a58c99ec1efe8b10cf834b3f0c0ebc7a05d71206f3c1202c4280952da`
- NEAR code hash (base58 sha256): `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`

The base58 hash equals the factory's default code hash, so this is byte-for-byte
the code a DAO created through the factory runs.
