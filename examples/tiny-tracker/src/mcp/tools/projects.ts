import type { ToolDef } from "../types.js";
import { applied, fail, fromBackend, notApplied, ok, type WriteContext } from "../results.js";
import { enc, object, readOnly, S, writes } from "./common.js";

export const listProjects: ToolDef = {
  name: "list_projects",
  title: "List projects",
  description: "List all projects with their keys and names.",
  input: object({}),
  mutates: false,
  annotations: readOnly,
  async handler(_args, { api }) {
    const res = await api.request("GET", "/projects");
    if (!res.ok) return fromBackend(res, "projects");
    const projects = res.body.projects as Array<{ key: string; name: string }>;
    return ok(projects.map((p) => `${p.key}: ${p.name}`).join("\n") || "No projects.", { projects });
  },
};

export const createProject: ToolDef = {
  name: "create_project",
  title: "Create a project",
  description: "Create a new project. If a project with this key already exists, nothing is changed and you get an error. "
    + "Pass an idempotency_key so that retrying after a lost answer is answered with the first result.",
  input: object({ key: S.projectKey, name: { type: "string", minLength: 1, maxLength: 100 }, idempotency_key: S.idempotencyKey }, ["key", "name"]),
  mutates: true,
  annotations: writes({ destructive: false, idempotent: false }),
  async handler({ key, name, idempotency_key }, { api }) {
    // POST, never PUT: a create must not replace an existing project (MWS-TGT-3). The key goes to the backend, which
    // answers a repeat with the first result; a new key for a key that exists is refused by the duplicate check.
    const w: WriteContext = { operation: "create", type: "project", id: key, guard: idempotency_key !== undefined ? "key" : null, read: { tool: "list_projects", arguments: {} } };
    const res = await api.request("POST", "/projects", { body: { key, name }, idempotencyKey: idempotency_key });
    if (res.status === 422 && res.body?.error === "idempotency_key_reused") {
      return fail("This idempotency_key was already used with different arguments; nothing was written. "
        + "If you are retrying the same create, send exactly the same arguments as the first call.", { error: "idempotency_key_reused" }, notApplied(w, "idempotency_key_reused", { argument: "/idempotency_key" }));
    }
    // Only the backend's duplicate check means "already exists"; any other 409 (in_progress, key_fenced, run_reset) is
    // answered by its own code through fromBackend (G1 review, fold-in 3).
    if (res.status === 409 && res.body?.error === "exists") {
      return fail(`Project ${key} already exists; nothing was changed. Choose another key.`, { exists: true, key }, notApplied(w, "already_exists", { argument: "/key" }));
    }
    if (!res.ok) return fromBackend(res, `project ${key}`, w);
    if (res.replayed) {
      return ok(`Project ${key} was already created by an earlier call with this idempotency_key; nothing new was written (replay).`,
        { key, version: res.body.project.version, created: true, replayed: true }, applied(w, { version: res.body.project.version, changed: ["key", "name"], replayed: true }));
    }
    return ok(`Created project ${key}.`, { key, version: res.body.project.version, created: true, replayed: false },
      applied(w, { version: res.body.project.version, changed: ["key", "name"] }));
  },
};

export const deleteProject: ToolDef = {
  name: "delete_project",
  title: "Delete an empty project",
  description: "Delete a project that has no tickets. Delete its tickets first with delete_tickets. "
    + "Projects carry no version the backend checks, so a delete made from a stale read is not detected.",
  input: object({ key: S.projectKey }, ["key"]),
  mutates: true,
  annotations: writes({ destructive: true, idempotent: true }),
  async handler({ key }, { api }) {
    const w: WriteContext = { operation: "delete", type: "project", id: key, guard: null, read: { tool: "list_projects", arguments: {} } };
    const res = await api.request("DELETE", `/projects/${enc(key)}`);
    if (!res.ok) return fromBackend(res, `project ${key}`, w);
    return ok(`Deleted project ${key}.`, { key, deleted: true }, applied(w));
  },
};
