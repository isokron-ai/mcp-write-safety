// The backend defect: the platform itself loses concurrent updates. A tester
// must see the loss through the MCP server AND through the REST API called
// directly (the control arm), and report `platform`, not `violated`. With the
// correct backend, neither arm loses anything.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startStack, type Stack } from "./support/stack.js";

const PAIRS = 5;

async function lostPairs(stack: Stack, arm: "mcp" | "control"): Promise<number> {
  const mcp = await stack.connect();
  const p = stack.prefix(`plat-${arm}`);
  await stack.rest.createProject(p);
  let lost = 0;
  for (let i = 0; i < PAIRS; i++) {
    const t = await stack.rest.createTicket({ project: p, title: "t0" });
    if (arm === "mcp") {
      await Promise.all([
        mcp.call("update_ticket", { force: true, id: t.id, title: `A${i}` }),
        mcp.call("update_ticket", { force: true, id: t.id, assignee: `b${i}` }),
      ]);
    } else {
      await Promise.all([
        stack.rest.send("PATCH", `/tickets/${t.id}`, { title: `A${i}` }),
        stack.rest.send("PATCH", `/tickets/${t.id}`, { assignee: `b${i}` }),
      ]);
    }
    const after = await stack.rest.ticket(t.id);
    if (after.title !== `A${i}` || after.assignee !== `b${i}`) lost++;
  }
  return lost;
}

function verdict(mcpLost: number, controlLost: number): string {
  if (mcpLost === 0) return "not observed";
  return controlLost > 0 ? "platform" : "violated";
}

describe("--backend-defect lost-update (the platform verdict)", () => {
  it("loses updates through the MCP server and through the API alike: platform", async () => {
    const stack = await startStack({ backendDefects: ["lost-update"] });
    try {
      const m = await lostPairs(stack, "mcp");
      const c = await lostPairs(stack, "control");
      assert.ok(m > 0, "the MCP arm lost nothing");
      assert.ok(c > 0, "the control arm lost nothing");
      assert.equal(verdict(m, c), "platform");
    } finally {
      await stack.close();
    }
  });

  it("correct backend: neither arm loses an update", async () => {
    const stack = await startStack();
    try {
      assert.equal(await lostPairs(stack, "mcp"), 0);
      assert.equal(await lostPairs(stack, "control"), 0);
    } finally {
      await stack.close();
    }
  });
});
