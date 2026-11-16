// Variants: correct alternatives to a piece of the build, switched on with
// TRACKER_VARIANTS (comma-separated). A variant is not a defect: a run against
// it must give no `violated`. Unknown names stop the server (fail closed).

import { ConfigError } from "../mcp/config.js";
import type { Build } from "../mcp/types.js";
import { applyKeyStoreHonest } from "./key-store-honest.js";

export const VARIANTS = ["key-store-honest"] as const;

export function applyVariants(build: Build, env: Record<string, string | undefined>): string[] {
  const names = (env.TRACKER_VARIANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    if (name === "key-store-honest") {
      const journal = env.TRACKER_KEY_JOURNAL;
      if (!journal) throw new ConfigError("TRACKER_VARIANTS=key-store-honest needs TRACKER_KEY_JOURNAL (a file for the journal of used keys). Not starting.");
      applyKeyStoreHonest(build, journal);
    } else {
      throw new ConfigError(`TRACKER_VARIANTS names an unknown variant: ${name} (known: ${VARIANTS.join(", ")}). Not starting.`);
    }
  }
  return names;
}
