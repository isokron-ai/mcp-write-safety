/**
 * The MWS-RES-2 second-clause texts of the rule-11 coverage research ("declared-carryover"; its res2-detail.json,
 * rebuilt by extract.py): the patched builds of three cited
 * servers (fix evidence) and the purpose-built fake2. truth is the research's reading of each text.
 */
export const CARRYOVER: { src: string; case: string; truth: 'held' | 'violated' | 'amb'; text: string }[] = [
 {
  "src": "fix-evidence",
  "case": "grafana-fix",
  "truth": "held",
  "text": "outcome unknown: POST /api/dashboards/db was sent to Grafana, but no response was received (EOF). The change may or may not have been applied. Read the current "
 },
 {
  "src": "fix-evidence",
  "case": "kubernetes-fix",
  "truth": "held",
  "text": "outcome unknown: PATCH /api/v1/namespaces/mwsv-fix-a/configmaps/mwsv-fix-cut was sent to the Kubernetes API, but no response was received (EOF). The change may "
 },
 {
  "src": "fix-evidence",
  "case": "fastmcp-fix",
  "truth": "held",
  "text": "Upstream request timed out after it was sent. No response was received, so it is not known whether the request took effect. Check the current state before retry"
 },
 {
  "src": "fix-evidence",
  "case": "fastmcp-fix",
  "truth": "held",
  "text": "Upstream request timed out. If the request was sent, it may have taken effect: check the current state before retrying"
 },
 {
  "src": "fix-evidence",
  "case": "fastmcp-fix",
  "truth": "violated",
  "text": "Upstream request timed out, please retry"
 },
 {
  "src": "fix-evidence",
  "case": "tiny-tracker-fix",
  "truth": "held",
  "text": "The tracker backend gave no answer: it could not be reached, or the connection broke after the request was sent. It is not known whether the change was applied;"
 },
 {
  "src": "fake2",
  "case": "p-clear",
  "truth": "held",
  "text": "The close step was refused by the backend (HTTP 409). The assignee was updated to zed and that change remains applied."
 },
 {
  "src": "fake2",
  "case": "p-none",
  "truth": "violated",
  "text": "The backend refused the request (HTTP 409)."
 },
 {
  "src": "fake2",
  "case": "p-unreadable",
  "truth": "amb",
  "text": "E_PARTIAL_17"
 },
 {
  "src": "fake2",
  "case": "p-neg-identifies",
  "truth": "held",
  "text": "The ticket could not be closed. No rollback was made: the assignee stays zed."
 },
 {
  "src": "fake2",
  "case": "p-neg-false",
  "truth": "violated",
  "text": "The assignee field is read-only for closed tickets. Audit entry saved. No change was made to the ticket."
 },
 {
  "src": "fake2",
  "case": "p-oldnew",
  "truth": "amb",
  "text": "Close refused (HTTP 409). assignee: old value \"\", new value \"zed\"."
 },
 {
  "src": "fake2",
  "case": "p-de",
  "truth": "held",
  "text": "Schließen abgelehnt (HTTP 409). Die Zuweisung an zed wurde gespeichert und bleibt bestehen."
 },
 {
  "src": "fake2",
  "case": "p-de-unknown",
  "truth": "held",
  "text": "Schließen abgelehnt (HTTP 409). Es ist nicht bekannt, ob die Zuweisung geändert wurde."
 },
 {
  "src": "fake2",
  "case": "p-echo",
  "truth": "violated",
  "text": "Close refused (HTTP 409). Your request was: {\"id\":\"T1\",\"assignee\":\"zed\",\"comment\":\"applied\"}"
 },
 {
  "src": "fake2",
  "case": "p-unknown",
  "truth": "held",
  "text": "The close step was refused (HTTP 409). It is not known whether the assignee change was applied."
 },
 {
  "src": "fake2",
  "case": "p-unknown-other",
  "truth": "held",
  "text": "The close step was refused (HTTP 409). The state of the ticket is indeterminate; read it before you retry."
 },
 {
  "src": "fake2",
  "case": "u-unknown",
  "truth": "held",
  "text": "The backend did not answer. It is not known whether the update was applied."
 },
 {
  "src": "fake2",
  "case": "u-failed",
  "truth": "violated",
  "text": "The update failed."
 },
 {
  "src": "fake2",
  "case": "u-unreadable",
  "truth": "amb",
  "text": "E_UPSTREAM_17"
 },
 {
  "src": "fake2",
  "case": "u-neg-unknown",
  "truth": "held",
  "text": "The backend did not answer. The update was not confirmed as failed, and it was not confirmed as written either: read the ticket before you retry."
 },
 {
  "src": "fake2",
  "case": "u-neg-nochange",
  "truth": "violated",
  "text": "The backend did not answer. No change was made."
 },
 {
  "src": "fake2",
  "case": "u-oldnew",
  "truth": "amb",
  "text": "The backend did not answer. assignee: old value \"ann\", requested value \"bob\"."
 },
 {
  "src": "fake2",
  "case": "u-identifies",
  "truth": "held",
  "text": "The backend did not answer in time, but assignee was updated to bob on ticket T1."
 },
 {
  "src": "fake2",
  "case": "u-de",
  "truth": "held",
  "text": "Das Backend hat nicht geantwortet. Es ist nicht bekannt, ob die Änderung angewendet wurde."
 },
 {
  "src": "fake2",
  "case": "u-echo",
  "truth": "violated",
  "text": "Connection to the backend lost. {\"request\":{\"id\":\"T1\",\"assignee\":\"bob\"},\"retry_policy\":\"requests that may have succeeded are never retried by this server\"}"
 },
 {
  "src": "fake2",
  "case": "u-bare",
  "truth": "violated",
  "text": "Connection to the backend lost."
 }
];
