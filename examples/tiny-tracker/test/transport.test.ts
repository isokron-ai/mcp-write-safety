// When the backend cannot be reached, or the connection breaks, the correct
// build says it does not know whether the change was applied (MWS-RES-2).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startStack } from "./support/stack.js";

describe("backend unreachable", () => {
  it("a write fails with isError and says the outcome is unknown", async () => {
    const stack = await startStack();
    try {
      const mcp = await stack.connect();
      await stack.rest.createProject(stack.prefix("net"));
      const t = await stack.rest.createTicket({ project: stack.prefix("net"), title: "x" });
      await stack.gate.close(); // the hop between the MCP server and the backend goes away
      const r = await mcp.call("update_ticket", { force: true, id: t.id, title: "y" });
      assert.equal(r.isError, true);
      assert.equal(r.protocolError, undefined);
      assert.equal(r.structured.written, "unknown");
      assert.match(r.text, /not known whether the change was applied/);
      const bulk = await mcp.call("bulk_update_tickets", { project: stack.prefix("net"), ids: [t.id], status: "closed" });
      assert.equal(bulk.isError, true);
      assert.equal(bulk.structured.written, "unknown");
    } finally {
      await stack.close();
    }
  });
});
