# Stream F: text for FIXTURE.md and the README (0.4.0 contract kit)

The lane lead merges these sections into FIXTURE.md and the README at release.

## For the README: Run it

**Over stdio.** `npx -y @mcp-write-safety/tiny-tracker stdio` speaks MCP on stdin and stdout, so a client that launches servers as a command can run it directly. The backend runs inside the same process on a loopback port; `--backend-url URL` (with `TRACKER_BACKEND_TOKEN`) points it at one you run yourself. stdout carries only protocol messages: the state line and the broken-build banner go to stderr. The process exits when stdin closes. `--defect`, `--read-only`, `--tools`, `--default-project`, `--profile` and `--features` work as for `all`. Fixture-layer features (`evidence` and the 0.2.0 fixture features) and `--fixture-control` run over Streamable HTTP only in this version.

**In a container.** The image runs `tiny-tracker all` on port 47310 in container mode. Container mode listens on every interface inside the container, so it needs a bearer token for `/mcp` and will not start without one:

```sh
docker build -t tiny-tracker examples/tiny-tracker
install -m 600 /dev/null mcp.token && openssl rand -hex 24 > mcp.token
docker run --rm --init -p 127.0.0.1:47310:47310 \
  -v "$PWD/mcp.token:/run/secrets/mcp.token:ro" -e TRACKER_MCP_TOKEN_FILE=/run/secrets/mcp.token tiny-tracker
```

Send `Authorization: Bearer <token>` with every request to `http://127.0.0.1:47310/mcp`. Publish the port on `127.0.0.1` only: Host and Origin checks still allow only `localhost` and `127.0.0.1`. `docker run --rm -i tiny-tracker stdio` needs no token. The image runs as the unprivileged `node` user; `/data` and `/tokens` are 0700 for `--data-dir` and `--token-dir`.

**A bearer token outside a container.** Set `TRACKER_MCP_TOKEN` (or `TRACKER_MCP_TOKEN_FILE`, a file only you can read) and `/mcp` answers 401 without it. The token follows the rules of every other token: 16 to 256 printable characters, different from every other token, never on the command line, never printed.

Settings table rows:

| Variable | Flag | Meaning |
|---|---|---|
| `TRACKER_MCP_TOKEN` / `TRACKER_MCP_TOKEN_FILE` | | Bearer token for `/mcp`. Required in container mode; optional otherwise. Refused with `stdio`. |
| `TRACKER_CONTAINER` | | `1` in the image: listen on every interface, and refuse to start without an MCP token. Only `1` or `0`. Refuses `tiny-tracker backend`. |

Remove from "What this does not cover yet": the stdio line.

## For FIXTURE.md: Transports and limits

- **Transports.** Streamable HTTP (both protocol eras) and stdio (both eras, settled on the opening exchange). The tools, instructions and capabilities are the same over both; a test checks stdio against the published 0.1.0 surface. A reduced self-test matrix runs over stdio: every check against the correct build, and one defect per requirement (the MWS-CFG checks start their own servers over HTTP and are covered by the full matrix).
- **Listener caps (X5).** The MCP listener caps a request body at 4 MiB, connections at 256 and requests in flight at 64 (503 with `Retry-After` beyond), allows 10 s for headers and 30 s for a request, and cuts off a POST left unanswered for 120 s by closing the connection without a reply. A fault's hold or delay has its own, smaller cap; the listener's is the backstop. A stdio message is capped at 4 MiB.
- **Container (X1).** Container mode needs a bearer token for `/mcp` and refuses to start without one. The backend and evidence listener stays on the container's loopback in this version, so a harness outside the container reaches the MCP layer only. Reaching evidence from outside the container is an open item for 0.4.0.
- **Data dir.** Created 0700; an existing one that others can read, write or search is refused, as is a symlink.

## For FIXTURE.md: Reproducibility

CI runs the suite on Linux, macOS and Windows with Node 22 and 24, and runs every known-answer generator three times per platform in fresh processes; any byte difference fails the run, and the bytes are kept as build artifacts so anyone can compare platforms. Today the generator is the 0.1 surface transcript of the tree; the `expected/` generator joins it when it lands.
