// Assembles a build: the correct tools, validation and config rules, then any
// defects named on the command line applied on top, each replacing one piece.

import type { Build, ToolDef } from "./types.js";
import { correctValidation } from "./validate.js";
import { correctConfigRules } from "./config.js";
import { listProjects, createProject, deleteProject } from "./tools/projects.js";
import { listTickets, getTicket, createTicket, updateTicket, replaceTicket, deleteTicket, deleteTickets, closeTicket } from "./tools/tickets.js";
import { addLabel, removeLabel, setLabels } from "./tools/labels.js";
import { addComment } from "./tools/comments.js";
import { bulkUpdateTickets } from "./tools/bulk.js";
import { resolveDefects } from "../defects/index.js";

export const CORRECT_TOOLS: ToolDef[] = [
  listProjects, createProject, deleteProject,
  listTickets, getTicket, createTicket, updateTicket, replaceTicket, deleteTicket, deleteTickets, closeTicket, bulkUpdateTickets,
  addComment, addLabel, removeLabel, setLabels,
];

export function createBuild(defectNames: string[] = []): Build {
  const build: Build = {
    tools: new Map(CORRECT_TOOLS.map((t) => [t.name, { ...t }])),
    validation: { ...correctValidation },
    configRules: { ...correctConfigRules },
    defects: [],
  };
  const defects = resolveDefects(defectNames);
  // Replacing defects first, wrapping ones after, so that none hides another.
  for (const defect of [...defects.filter((d) => !d.wraps), ...defects.filter((d) => d.wraps)]) {
    defect.apply(build);
    build.defects.push(defect.name);
  }
  return build;
}
