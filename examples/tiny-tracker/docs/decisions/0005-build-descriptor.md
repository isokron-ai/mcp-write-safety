# 0005. Every run identifies its build: `GET /build`, two hashes, mirrored over MCP

- Status: accepted (16 Nov 2026)
- Applies from: Phase 0 (feature `evidence`, as a stub: journal, faults and clock carry their empty values until they are built)

## Context

Published evidence should not rest on a harness's own note of what it started. The MCP instructions of 0.1.0 name MCP-layer defects only; variants, backend defects, features, armed faults and the clock offset are invisible to a client.

## Decision

1. **`GET /build`** on the backend listener, with the read-only evidence token, serves the build descriptor (`schemas/build-descriptor-1.schema.json`): package version, profile, features, defects of both layers, variants, control on or off, durability, the pinned contract commit, the process layout, boot id, restart count, journal head, armed faults and the clock domain and offset.
2. **Two hashes**, each SHA-256 over RFC 8785 bytes under its own domain tag (0002):
   - `build_hash` covers the configuration, which is the same on every start with the same settings. Known-answer files are keyed by it.
   - `descriptor_hash` covers every field, including this process's state. Two snapshots with the same `descriptor_hash` agree in every field.
3. **Mirrored:** with the `evidence` feature, the MCP instructions carry the descriptor's facts in one JSON line, with a banner for backend defects; every tool result carries `build_hash`, `descriptor_hash` and `boot_id` in `_meta` under `dev.writesafety.tiny-tracker/build`. A client that reaches only the MCP port can still record what it ran against.
4. **Readiness** is read from the descriptor (boot id, restart count), not only from a stdout line.
5. No token, secret or path is ever part of the descriptor.

## Consequences

- One hash names a build in published evidence and in `expected/` files.
- A restart changes `descriptor_hash` and `boot_id`, never `build_hash`.
- Under `--profile 0.1` nothing is mirrored, so the 0.1 surface stays exact.
