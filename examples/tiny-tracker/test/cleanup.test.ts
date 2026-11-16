// The suite cleans up after itself through the server's own tools: every
// object a run creates carries the run prefix, so list + delete by prefix
// leaves the tracker as it was.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startStack } from "./support/stack.js";

describe("cleanup by run prefix through the MCP tools", () => {
  it("removes every object the run created and nothing else", async () => {
    const stack = await startStack();
    try {
      const mcp = await stack.connect();
      const before = await stack.rest.export();
      const run = stack.prefix("clean");
      for (const n of [1, 2]) {
        const key = `${run}-${n}`;
        await mcp.call("create_project", { key, name: key });
        await mcp.call("create_ticket", { project: key, title: `${run} ticket a` });
        await mcp.call("create_ticket", { project: key, title: `${run} ticket b`, status: "closed" });
      }
      await mcp.call("create_ticket", { title: `${run} in the default project` });

      // Sweep: tickets carrying the prefix anywhere, then the run's projects.
      const listed = await mcp.call("list_tickets", { title_prefix: run });
      for (const t of listed.structured.tickets) {
        const r = await mcp.call("delete_ticket", { id: t.id, expected_version: t.version });
        assert.equal(r.isError, false, r.text);
      }
      const projects = await mcp.call("list_projects", {});
      for (const p of projects.structured.projects.filter((p: any) => p.key.startsWith(run))) {
        const r = await mcp.call("delete_project", { key: p.key });
        assert.equal(r.isError, false, r.text);
      }
      const after = await stack.rest.export();
      assert.deepEqual(after.projects.map((p) => p.key), before.projects.map((p) => p.key));
      assert.equal(after.tickets.length, before.tickets.length);
    } finally {
      await stack.close();
    }
  });
});
