// DEFECT create-overwrites -- MWS-TGT-3 (MUST)
// A create that meets an existing object of the same name does not overwrite
// it and report "created".
//
// WRONG ON PURPOSE. Correct code: createProject in src/mcp/tools/projects.ts.
//
// What goes wrong: create_project uses the backend's create-or-replace PUT
// instead of POST. When the key is taken, the existing project's name is
// replaced, and the tool still answers "Created project".
//
// Mirrors: Kubernetes K8S-08 (`vm_create` overwrites an existing VM and
// answers "created successfully").
//   https://isokron.ai/research/kubernetes-mcp-server-audit?utm_source=tiny-tracker-source&utm_medium=source#findings-register

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { fromBackend, ok } from "../mcp/results.js";

export const defect: Defect = {
  name: "create-overwrites",
  requirement: "MWS-TGT-3",
  summary: "create_project replaces an existing project with the same key and reports it as created",
  mirrors: "Kubernetes K8S-08",
  replaces: "createProject (src/mcp/tools/projects.ts)",
  apply(build) {
    const correct = build.tools.get("create_project")!;
    patchTool(build, "create_project", {
      async handler(args, deps) {
        // A call with an idempotency_key takes the correct keyed path (POST, the key sent to the backend), so that this
        // defect trips MWS-TGT-3 and not MWS-RETRY-2 as well; the defect is in the unkeyed create below.
        if (args.idempotency_key !== undefined) return correct.handler(args, deps);
        const { key, name } = args;
        const { api } = deps;
        // DEFECT: PUT is create-or-replace; the "created" flag in the answer is ignored.
        const res = await api.request("PUT", `/projects/${encodeURIComponent(key)}`, { body: { name } });
        if (!res.ok) return fromBackend(res, `project ${key}`);
        return ok(`Created project ${key}.`, { key, version: res.body.project.version, created: true });
      },
    });
  },
};
