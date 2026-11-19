// JSON Schemas with $ids (review C2): each schema names itself, the examples
// and the vectors validate, and a live GET /build validates against the build
// descriptor schema. The full validation uses the Python jsonschema package
// when it is installed (verify/python/check_schemas.py); the $id and shape
// checks here need nothing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCli } from "./support/cli-run.js";

const DIR = fileURLToPath(new URL("../../schemas/", import.meta.url));
const CHECK = fileURLToPath(new URL("../../verify/python/check_schemas.py", import.meta.url));
const BASE = "https://writesafety.dev/schemas/tiny-tracker/";

const jsonschema = spawnSync("python3", ["-I", "-c", "import jsonschema, referencing"], { encoding: "utf8" }).status === 0;
/** TT_GATE=1 (gate runs, CI): a missing jsonschema fails these tests instead of skipping them. */
const needJsonschema = jsonschema || process.env.TT_GATE === "1" ? false : "the Python jsonschema package is not installed";

describe("JSON Schemas", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".schema.json"));

  it("one schema per published object, each with a $id that names its own file, draft 2020-12", () => {
    for (const name of ["build-descriptor", "execution-record", "operation-record", "ledger-entry", "expected", "served-digest", "digest-vectors"]) {
      assert.ok(files.includes(`${name}-1.schema.json`), name);
    }
    for (const f of files) {
      const s = JSON.parse(readFileSync(`${DIR}${f}`, "utf8"));
      assert.equal(s.$id, `${BASE}${f}`);
      assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.ok(s.title && s.description, f);
      assert.doesNotMatch(JSON.stringify(s), /\b(compliant|certified|badge|score)\b/i, f);
    }
  });

  it("every schema is valid, every example and the digest vectors validate (python3 jsonschema)", { skip: needJsonschema }, () => {
    assert.ok(jsonschema, "TT_GATE=1 needs python3 with jsonschema and referencing");
    const r = spawnSync("python3", ["-I", CHECK], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /7 schemas, 5 examples, 0 problems/);
  });

  it("a live GET /build validates against build-descriptor-1", { skip: needJsonschema }, async () => {
    assert.ok(jsonschema, "TT_GATE=1 needs python3 with jsonschema and referencing");
    const env = { TRACKER_BACKEND_TOKEN: "backend-token-schema-00000000000", TRACKER_EVIDENCE_TOKEN: "evidence-token-schema-0000000000", TRACKER_CONTROL_TOKEN: "control-token-schema-00000000000" };
    for (const [args, ports] of [[["all", "--features", "evidence,strict-input", "--defect", "all", "--backend-defect", "lost-update"], [4690, 4691]],
      [["all", "--features", "evidence", "--read-only", "true", "--tools", "list_tickets,get_ticket"], [4690, 4691]]] as const) {
      const portArgs = args[0] === "all" ? ["--port", String(ports[0]), "--backend-port", String(ports[1])] : ["--port", String(ports[0])];
      const r = await runCli([...args, ...portArgs], env, async (state) => {
        const res = await fetch(`${state.backend}/build`, { headers: { authorization: `Bearer ${env.TRACKER_EVIDENCE_TOKEN}` } });
        const body = await res.text();
        const check = spawnSync("python3", ["-I", CHECK, "--instance", "build-descriptor"], { input: body, encoding: "utf8" });
        assert.equal(check.status, 0, `${args.join(" ")}: ${check.stdout}${check.stderr}`);
        const d = JSON.parse(body);
        assert.ok(d.config, "the server settings are in the descriptor once the state line is out");
        if ((args as readonly string[]).includes("--read-only")) assert.deepEqual(d.config, { read_only: true, tools: ["get_ticket", "list_tickets"], deny_tools: null, default_project: "inbox", key_journal: false });
      });
      assert.equal(r.code, 0, r.stderr);
    }
  });
});
