/** Shared pieces of the Kubernetes-shaped regression tests: the guard, the seeded namespace and the ConfigMap resource of the validation manifest. */

import type { ShapeBackend } from './backend.js';

export const K8S_GUARD = '{ tool: namespaces_list, args: {}, pattern: "mwsv-a" }';

export const seedNamespace = (b: ShapeBackend): void => {
  b.seed('k8s', { id: 'Namespace::mwsv-a', apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'mwsv-a' }, title: 'mwsv-a', scope: '' });
};

/**
 * The validation manifest's ConfigMap resource (kubernetes/writecheck.yaml, `configmap-norv`: the object
 * sent back without a version), read through `read`.
 */
export const configmap = (name: string, read: string): string => `  - name: ${name}
    vars: { ns: mwsv-a }
    create:
      tool: resources_create_or_update
      args: { resource: '{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"{{marker}}","namespace":"{{ns}}"},"data":{"alpha":"a1"},"binaryData":{"blob":"YjE="}}' }
      id: "[0].metadata.name"
      name_path: metadata.name
    read: ${read}
    update:
      tool: resources_create_or_update
      mode: full_replace
      args: { resource: '{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"{{id}}","namespace":"{{ns}}"},"data":{{json:object.data}},"binaryData":{{json:object.binaryData}}}' }
    fields:
      - { path: data, values: [{ alpha: a1 }, { alpha: a2 }], skip: [empty] }
      - { path: binaryData, values: [{ blob: "YjE=" }, { blob: "YjI=" }], skip: [empty] }
    delete: { tool: resources_delete, args: { apiVersion: v1, kind: ConfigMap, name: "{{id}}", namespace: "{{ns}}" } }
    cleanup: delete
`;
