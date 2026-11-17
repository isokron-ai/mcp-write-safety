# syntax=docker/dockerfile:1
#
# tiny-tracker in a container (0.4.0, review S3), for harness authors without Node.
#
# Built from the npm tarball of this tree (`npm pack`), installed with production dependencies only, run as the
# unprivileged `node` user. Container mode (TRACKER_CONTAINER=1) listens on every interface inside the container and
# therefore refuses to start without a bearer token for /mcp (review X1). Host and Origin checks still allow only
# localhost and 127.0.0.1, so publish the port on loopback:
#
#   docker build -t tiny-tracker examples/tiny-tracker
#   install -m 600 /dev/null mcp.token && openssl rand -hex 24 > mcp.token     # owned by uid 1000, mode 0600
#   docker run --rm --init -p 127.0.0.1:47310:47310 \
#     -v "$PWD/mcp.token:/run/secrets/mcp.token:ro" -e TRACKER_MCP_TOKEN_FILE=/run/secrets/mcp.token \
#     tiny-tracker                                       # then: Authorization: Bearer <token> on http://127.0.0.1:47310/mcp
#   docker run --rm -i tiny-tracker stdio                # stdio needs no token: there is no listener
#
# The evidence routes (GET /build, /ledger, /executions, /operations, /export) for a harness outside the container
# (owner decision: evidence reachable behind its token): name the evidence feature and TRACKER_EVIDENCE_LISTEN, and
# give the evidence token the same way as the MCP token. Only the evidence routes are served there, for any Host, and
# only with the evidence token; the backend API stays on the container's loopback. A defect build may do this too,
# since container mode never starts without the bearer token on /mcp.
#
#   docker run --rm --init -p 127.0.0.1:47310:47310 -p 127.0.0.1:47312:47312 \
#     -v "$PWD/mcp.token:/run/secrets/mcp.token:ro" -e TRACKER_MCP_TOKEN_FILE=/run/secrets/mcp.token \
#     -v "$PWD/evidence.token:/run/secrets/evidence.token:ro" -e TRACKER_EVIDENCE_TOKEN_FILE=/run/secrets/evidence.token \
#     -e TRACKER_EVIDENCE_LISTEN=0.0.0.0:47312 \
#     tiny-tracker all --port 47310 --features evidence,strict-input,execution-records,lookup,principals,ledger
#
# Without a token the container exits 2 at once with the reason on stderr. The token is never baked into the image,
# never on the command line and never printed. /data and /tokens are 0700 and owned by `node`, for --data-dir and
# --token-dir.
#
# Tested: CI's container job builds the image and checks the refusal, the bearer token, the evidence listener, the
# user and the data dir; the same start paths are tested in Node (test/listener.test.ts, test/integration-040.test.ts).
# Pin NODE_IMAGE by digest when publishing an image.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS pack
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
# prepack cleans and builds (tsc); the tarball holds exactly the package's "files".
RUN npm pack --no-audit --no-fund --pack-destination /out

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    TRACKER_CONTAINER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY --from=pack /out/ /tmp/pkg/
RUN npm install -g --omit=dev --ignore-scripts --no-audit --no-fund /tmp/pkg/*.tgz \
 && rm -rf /tmp/pkg /root/.npm \
 && install -d -m 0700 -o node -g node /data /tokens
USER node
WORKDIR /data
EXPOSE 47310
# The evidence listener, when TRACKER_EVIDENCE_LISTEN names it (see above).
EXPOSE 47312
STOPSIGNAL SIGTERM
ENTRYPOINT ["tiny-tracker"]
CMD ["all", "--port", "47310"]
