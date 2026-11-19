// Preloaded with --import: registers the logging hooks (import-hooks.ts) with
// the log path from TT_IMPORT_LOG.

import { register } from "node:module";

register(new URL("./import-hooks.js", import.meta.url), { data: { log: process.env.TT_IMPORT_LOG ?? "" } });
