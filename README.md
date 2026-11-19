<img src="https://raw.githubusercontent.com/isokron-ai/mcp-write-safety-kits/main/assets/mws-mark-128.png" alt="MCP Write-Safety Requirements mark" width="72" height="72">

<sub>The MWS mark is not covered by this repository's licences; its use is described in <a href="TRADEMARKS.md">TRADEMARKS.md</a>.</sub>

# MCP Write-Safety Requirements (MWS)

The MCP Write-Safety Requirements (MWS) are a specification for Model Context Protocol (MCP) servers whose tools change state: create, update and delete. They state what a server must do so that a write made through one of its tools has the effect the caller asked for, on the object the caller named, and is reported truthfully: a caller does not lose another writer's change, does not apply a write twice, and is not told that a write happened when it did not. They cover version checks, idempotency keys, strict input validation, truthful results, unknown outcomes and tool annotations, and each requirement comes with a test method.

**Status: MWS 0.9, a draft for public comment, published 16 November 2026, open for comment until 16 December 2026.** Every requirement has the status `draft`. Comments are made as issues in this repository, and every comment gets a recorded disposition. Version 1.0 follows the comment window ([section 1](spec/mws.md#1-status-of-this-document) of the specification gives the exit criteria).

Read the specification in [`spec/mws.md`](spec/mws.md) or at [isokron.ai/mws](https://isokron.ai/mws?utm_source=mws-readme&utm_medium=readme).

MWS is an independent draft. It is not a product of the Model Context Protocol project or of the foundation that hosts it, and no MCP maintainer and no maintainer of a cited server has endorsed it. It is written and stewarded by IsoKron, which sells audits and builds of MCP servers and so has a commercial interest in the subject (section 15.1 of the specification). Every finding it cites comes from IsoKron's own audits of November 2026. The text was drafted with the assistance of AI tools.

## What is in this repository

- `spec/`: the MCP Write-Safety Requirements (`spec/mws.md`, requirement IDs `MWS-…`); the findings register (`spec/evidence/FINDINGS.md`); the normative sentences on their own (`spec/NORMATIVE-SENTENCES.md`); the result shape `write-result/0.1` (`spec/shapes/`); the decision record (`spec/DECISIONS.md`). CC BY 4.0.
- `packages/writecheck/`: `mcp-writecheck` (npm package `@mcp-write-safety/writecheck`), a CLI that tests your own MCP server, in a test environment, against the requirements. In 0.9 it is a preview that covers a stated subset of the requirements; its [README](packages/writecheck/README.md) lists them. Apache-2.0.
- `examples/tiny-tracker/`: `@mcp-write-safety/tiny-tracker`, a small sample MCP server in a broken and a fixed build; it is also the test tool's self-test. Apache-2.0.
- `integrations/skills/`: two agent skills, one for building write tools that meet MWS and one for calling write tools safely. Apache-2.0.

To see the test tool run against the sample server, on your own machine only (Node 22 or later):

```sh
npx -y -p @mcp-write-safety/writecheck@0.1.0 -p @mcp-write-safety/tiny-tracker@0.1.0 mcp-writecheck demo --defect all
```

## Related repositories

- [isokron-ai/mcp-writecheck-action](https://github.com/isokron-ai/mcp-writecheck-action): a GitHub Action that runs `mcp-writecheck` in CI and reports the result in the job summary.
- [isokron-ai/mcp-write-safety-kits](https://github.com/isokron-ai/mcp-write-safety-kits): helper libraries for the write tools of an MCP server, in TypeScript and Python.

## Contributing

Comments on any part of the text are welcome as issues. A proposal to change a requirement follows [CONTRIBUTING.md](CONTRIBUTING.md) (the four-part rule). Contributions use the Developer Certificate of Origin (sign-off).

## Licences

The code (`packages/`, `examples/`, `integrations/`) is Apache-2.0 (`LICENSE`; `integrations/` carries its own `LICENSE` and `NOTICE`); the specification text and the result shape are CC BY 4.0 (`LICENSE-spec`). The name "MCP Write-Safety Requirements" and the MWS mark are covered by neither licence; see [TRADEMARKS.md](TRADEMARKS.md). Each package has a `CHANGELOG.md`.

Written and stewarded by [IsoKron](https://isokron.ai/?utm_source=mws-readme&utm_medium=readme).
