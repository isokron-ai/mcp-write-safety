# Stream E: the fixture clock and the supervisor (0.3.0)

Text for the lane lead to merge into FIXTURE.md and the README at release.

## The fixture clock (feature `clock`)

Two clock domains:

- **`wall`** is the process clock, with offset 0. Every build without the `clock` feature runs on it.
- **`fixture`** is wall time plus an offset that only the control listener moves. Its uses are retention rehearsals and key expiry.

How the offset moves:

- Request: `POST /_fixture/clock {"advance_ms": N}` on the control listener, with the control token.
- Response: `{domain, offset_ms, now, wall_now, moved}`. `GET /_fixture/clock` gives the same fields without `moved`.
- The clock only moves forward. Each step is 1 ms to 366 days, and the offset tops out at about 10 years.

Where the domain and offset show:

- Every record time (`created_at`, `committed_at`, `expires_at`) is in the clock's domain. Each write reads the clock once, as `committedAt`.
- Ledger and event `at` stay wall time.
- Every event carries `clock_offset_ms`.
- The build descriptor names the domain and the offset. The offset is not part of `build_hash`.

**A scored run.** The `clock` feature needs `--fixture-control` (CMP-60). A run whose `/build` shows `features` without `clock`, `control.enabled: false` and `clock: {domain: "wall", offset_ms: 0}` ran on wall time. A published delayed-recovery (A5) result must show exactly that.

## `tiny-tracker all --supervise`

The command runs two children, each a `tiny-tracker all` that starts one half:

- **backend:** the backend, the evidence routes and the control listener;
- **mcp:** the MCP server, pointed at the backend child.

When a child stops, the supervisor restarts it on the same port. The other child stays up.

**stdout:**

- One state line when both children are up. It has the shape `all` prints, plus `supervise: {boot_id, restarts: {backend, mcp}, boot_ids}`.
- One more line after each restart, with `restarted: "backend" | "mcp"`.

**Restart limit (X5).** A child that stops more than 100 times stops the supervisor, with exit 1.

**Start failure.** A child that cannot start ends the start with that child's exit code.

**Readiness by endpoint (G9).** `GET /build` (backend child) gives:

- `process.boot_id`, which is new on every start;
- `process.restart_count`;
- a `supervision` member with the supervisor's boot id and each child's boot id and restart count.

**Hashes.** `build_hash` is the same as for plain `all` with the same settings. Every committed transaction carries the backend child's boot id.

## Crash fault points

| Point | Where it stops | What a client sees |
|---|---|---|
| `backend/before-commit/crash` | After the pending key record, before the synchronous section. Nothing is validated or written. | A reset connection. |
| `backend/after-commit/crash` | After journal, apply and ledger, before the reply. | A reset connection. The write is in effect. |
| `mcp/after-backend-reply/crash` | In the MCP child, after the backend answered. The backend stays up. | No answer from the MCP server: the lost response, server-side. |

Rules for crash points:

- A crash point needs `--supervise` (CMP-63). Without it the arming store refuses one.
- The process writes one line to stderr and exits with status 70.

**Arming lives in the supervisor's state folder (0700), never on a child's command line.**

- `--fault POINT[:once]` is armed by the supervisor once, before the children start.
- A `once` fault is consumed, durably, before the process exits, so the restarted child does not crash again.
- Every firing is kept in the folder with the point, the time, the boot id and the commit sequence it fired on.
- `GET /build` lists the armed points.
