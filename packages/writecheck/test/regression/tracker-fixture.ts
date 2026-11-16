/** Shared manifest pieces of the tracker-shaped regression tests. */

/** The platform's own API for the control arm (test/regression/backend.ts), reached directly, never through the gate. */
export const CONTROL = `    control:
      base_env: SHAPE_URL
      read: { http: [GET, "/c/tickets/{{id}}"] }
      patch: { http: [PATCH, "/c/tickets/{{id}}"], body: { "{{field}}": "{{value}}" } }
      write: { http: [PUT, "/c/tickets/{{id}}"], body: "{{object}}", headers: { if-match: "{{version}}" } }
      delete: { http: [DELETE, "/c/tickets/{{id}}"] }
`;

/** A ticket resource: created by ticket_create, read by ticket_get, found again by the run prefix, deleted by id. */
export function ticket(o: { name?: string; create?: string; update: string; fields: string; extra?: string; control?: boolean; scope?: boolean }): string {
  return `  - name: ${o.name ?? 'ticket'}
${o.scope ? `    scope:
      resource: project
      arg: project
      default: inbox
      list: { tool: ticket_list, args: { project: "{{scope}}" }, items: tickets, id: id, name: title }
` : ''}    create: { tool: ticket_create, args: { ${o.scope ? 'project: "{{?scope}}", ' : ''}title: "{{marker}}"${o.create ? `, ${o.create}` : ''} }, id: id, name_path: title }
    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket, ignore: [updated_at] }
    update: ${o.update}
    fields:
${o.fields}
    version: { read: version }
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
    list: { tool: ticket_list, args: { title_prefix: "{{prefix}}" }, items: tickets, id: id, name: title }
    cleanup: delete
${o.extra ?? ''}${o.control === false ? '' : CONTROL}`;
}

/** Projects: the containers tickets live in; the tester creates its own. */
export const PROJECT = `  - name: project
    create: { tool: project_create, args: { key: "{{key}}", name: "{{marker}}" }, id: key, name_path: key }
    read: { tool: project_list, args: {}, items: projects, match: key }
    key: { arg: key, vary: { arg: name, path: name } }
    delete: { tool: project_delete, args: { key: "{{id}}" } }
    cleanup: delete
`;

export const PATCH_UPDATE = '{ tool: ticket_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }';
export const ASSIGNEE_STATUS = `      - { path: assignee, values: [ann, bob] }
      - { path: status, values: [blocked, closed] }`;
