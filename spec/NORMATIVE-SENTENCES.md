# MWS 0.9: the normative sentences

Copied verbatim from `spec/mws.md`; if the two differ, `spec/mws.md` governs. Each requirement is the sentence plus its applicability condition; nothing else in the specification adds to it.

Changed in the review round and by the owner's decisions of 14 and 15 November 2026, against the first 0.9 text, so that these can be read again on their own. New IDs: MWS-CONC-5, MWS-CONC-6, MWS-RETRY-3, MWS-IN-5, MWS-IN-6, MWS-IN-7, MWS-CFG-4, MWS-ANN-5. Changed: MWS-UPD-2 (level, sentence); MWS-CONC-2 (sentence); MWS-CONC-4 (sentence); MWS-TGT-2 (sentence); MWS-TGT-3 (condition); MWS-RES-2 (sentence); MWS-RES-4 (sentence); MWS-RETRY-2 (sentence); MWS-IN-1 (sentence); MWS-IN-2 (sentence); MWS-IN-3 (sentence, condition); MWS-CFG-1 (sentence, condition); MWS-CFG-2 (level, sentence, condition); MWS-ANN-2 (sentence, condition); MWS-ANN-3 (condition); MWS-ANN-4 (sentence); MWS-SEC-1 (condition). Every other sentence, condition and level is unchanged.

37 requirements: 26 MUST, 11 SHOULD.

## UPD: Update semantics

### 1. MWS-UPD-1 (MUST)

**Applies when:** the server offers an update tool in field-patch mode. A tool in full-replace mode is judged by MWS-CONC-2 and MWS-CONC-3 instead.

> An update tool in field-patch mode MUST change only the fields its arguments name, so that every other field of the object, apart from server-managed fields, keeps its stored value and no default is written that the caller did not send.

### 2. MWS-UPD-2 (MUST)

**Applies when:** the server offers a tool that edits, moves or removes one element of a list held inside an object.

> A tool that edits, moves or removes one element of a list MUST apply the change to the element that the caller's address denoted in the list as the caller read it, or refuse the call, when elements have been inserted, removed or reordered since that read.

## CONC: Concurrency and preconditions

### 3. MWS-CONC-1 (MUST)

**Applies when:** the backend offers a concurrency control for an operation that a write tool performs.

> A write tool MUST NOT disable or bypass a concurrency control that the backend offers for the operation it performs, unless the caller sets an explicit override argument whose default is off.

### 4. MWS-CONC-2 (MUST)

**Applies when:** the server offers a tool that replaces a whole object, deletes an object, or accepts a version from the caller.

> A tool that replaces a whole object, deletes an object or accepts a version MUST refuse the write with a conflict when the object has changed since the state the caller read, wherever the backend can detect the change.

### 5. MWS-CONC-3 (MUST)

**Applies when:** the server offers a write tool through which two different fields of one object can be changed, and the declaration names two such fields that are independent of each other.

> Two concurrent writes through the server to different parts of one object MUST NOT both report success when either change is absent afterwards.

### 6. MWS-CONC-4 (MUST)

**Applies when:** the server offers a write tool that can refuse a write because of a conflict.

> A write refused because of a conflict MUST NOT be applied and MUST be returned as a tool execution error (`isError: true`) that says the write was not applied.

### 7. MWS-CONC-5 (SHOULD)

**Applies when:** the server offers a tool that replaces a whole object, deletes an object, or accepts a version from the caller, and the backend cannot detect that the object has changed since the state the caller read.

> The description of a tool that replaces a whole object, deletes an object or accepts a version SHOULD state that stale writes are not detected, or are detected only on a best-effort basis by the server, where the backend cannot detect the change.

### 8. MWS-CONC-6 (SHOULD)

**Applies when:** the server offers a write tool that can refuse a write because the object has changed since the state the caller read.

> A conflict error SHOULD tell the caller to read the object again before it retries, or carry the object's current state.

## TGT: Targeting

### 9. MWS-TGT-1 (MUST)

**Applies when:** the server offers a write tool that accepts a scope argument.

> A write tool that accepts a scope argument MUST apply the write within the scope the argument names or reject the call, and MUST NOT apply it anywhere else.

### 10. MWS-TGT-2 (MUST)

**Applies when:** the server offers a tool that deletes, or that updates more than one object, and that accepts a selector or a path.

> A tool that deletes or bulk-updates MUST NOT treat an empty, missing or match-all selector, or the path of a container, as selecting every object in the container or collection unless the caller sets an explicit argument that opts in.

### 11. MWS-TGT-3 (MUST)

**Applies when:** the server offers a tool that its name and description present as a create, for a resource whose objects are identified by a name or key the caller chooses. A tool that its name and description present as an upsert or an apply is not a create for this purpose. A tool whose name and description present it as bringing a new object into being under a name the caller chooses (run, start, launch, deploy, install, clone; a start of an existing object does not) is a create for this purpose unless its name or description says that an existing object of that name is updated, replaced or applied over.

> A create tool MUST NOT overwrite an existing object that has the same name or key unless the caller sets an explicit argument that asks for the overwrite.

## RES: Truthful results

### 12. MWS-RES-1 (MUST)

**Applies when:** the server offers a write tool.

> A write tool MUST report success only when the state the caller asked for is in effect afterwards.

### 13. MWS-RES-2 (MUST)

**Applies when:** the server offers a write tool.

> A write that fails in whole or in part MUST NOT be reported as a success; the error MUST identify any change that remains applied, or say that it is not known whether a change was applied, and MUST NOT report a settled outcome as not known, and MUST NOT tell the caller to repeat a write whose outcome is open, except after a read that it names or with the idempotency key or the version that the call carried; and where the failure is a refusal or failure of the backend, or of a rule the tool applies, the error MUST be returned as a tool execution error (`isError: true`).

### 14. MWS-RES-3 (MUST)

**Applies when:** the server offers a tool that creates an object.

> A create tool MUST return the identifier of each object it created, including when a later step of the same call fails.

### 15. MWS-RES-4 (SHOULD)

**Applies when:** the server offers a tool that creates or updates an object.

> A write tool SHOULD return a receipt that identifies the object written, the fields changed and, where the resource has a version, its new version.

## ATOM: Multi-step and multi-item writes

### 16. MWS-ATOM-1 (MUST)

**Applies when:** the server offers a tool that writes more than one item, or makes more than one backend write, in one call.

> A multi-item or multi-step write that is not applied completely MUST NOT report success and MUST name which items or steps were applied and which were not.

### 17. MWS-ATOM-2 (SHOULD)

**Applies when:** the server offers a tool that writes more than one object in one call.

> A multi-object write SHOULD be all-or-nothing, so that when any part of it fails none of its changes remains applied.

## RETRY: Retries and replays

### 18. MWS-RETRY-1 (SHOULD)

**Applies when:** the server offers a create tool for which two calls with the same arguments create two objects.

> A create tool whose repeated call would create a second object SHOULD accept an idempotency key from the caller.

### 19. MWS-RETRY-2 (MUST)

**Applies when:** the server offers a write tool that accepts an idempotency key.

> A write repeated with the same idempotency key and the same arguments MUST be applied at most once and, where the first call applied it and the server can establish that, MUST be answered with the outcome of that call; a write with a different key MUST be treated as a new write; and a write that reuses a key with different arguments MUST be refused.

### 20. MWS-RETRY-3 (MUST)

**Applies when:** the server offers a write tool that can answer with an `input_required` result (MCP revision `2026-07-28`).

> A tool that answers with an `input_required` result MUST NOT have put into effect, in that call, the write the caller asked for, in whole or in part.

## IN: Inputs

### 21. MWS-IN-1 (MUST)

**Applies when:** the server offers a tool whose input schema declares a type for an argument.

> A tool MUST NOT coerce an argument to a value whose meaning differs from the value the caller sent.

### 22. MWS-IN-2 (MUST)

**Applies when:** the server offers a tool whose input schema does not explicitly allow additional properties at the level probed.

> A tool MUST NOT silently drop an argument that its input schema does not define.

### 23. MWS-IN-3 (MUST)

**Applies when:** the server offers a tool whose input schema declares a constraint with one of these keywords: `required`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`, `uniqueItems`, `minProperties`, `maxProperties`, `enum` or `const`.

> A tool MUST reject a call that breaks a constraint its input schema declares with a keyword listed in the applicability condition.

### 24. MWS-IN-4 (MUST)

**Applies when:** the server offers a tool that can refuse an argument.

> A tool MUST report an input validation failure as a tool execution error (`isError: true`) that names the argument at fault and the reason it was refused.

### 25. MWS-IN-5 (SHOULD)

**Applies when:** the server offers a tool, and the server or its backend enforces a fixed constraint on the value of one of the tool's arguments that the keywords listed in MWS-IN-3 can express.

> A tool's input schema SHOULD declare, with the keywords listed in MWS-IN-3, each fixed constraint on the value of a single argument that the server or its backend enforces.

### 26. MWS-IN-6 (SHOULD)

**Applies when:** the server offers a tool whose input schema declares a type for an argument.

> A tool SHOULD reject an argument whose value is not of a type its input schema declares for that argument, rather than convert or drop it.

### 27. MWS-IN-7 (SHOULD)

**Applies when:** the server offers a tool whose input schema does not explicitly allow additional properties at the level probed.

> A tool SHOULD reject an argument that its input schema does not define.

## CFG: Safety settings

### 28. MWS-CFG-1 (MUST)

**Applies when:** the server has a read-only mode or another setting, applied at start or with a request, whose purpose is to restrict writes.

> A server MUST NOT accept a write when a read-only or other write-restricting setting, applied at start or with a request, has a value it does not recognize.

### 29. MWS-CFG-2 (MUST)

**Applies when:** the server has a setting, applied at start or with a request, that denies tools by name.

> A server MUST refuse to start, refuse to serve the request that carries the list, or disable every write tool, when a tool deny-list contains a name that is not the name of a tool the server defines.

### 30. MWS-CFG-3 (MUST)

**Applies when:** the server has a read-only mode.

> In read-only mode a server MUST refuse every call to a write tool, whatever that tool's annotations declare.

### 31. MWS-CFG-4 (SHOULD)

**Applies when:** the server has a setting, applied at start or with a request, that allows tools by name.

> A server SHOULD refuse to start, or refuse to serve the request that carries the list, when a tool allow-list contains a name that is not the name of a tool the server defines.

## ANN: Annotations

### 32. MWS-ANN-1 (MUST)

**Applies when:** the server offers a tool that declares `readOnlyHint: true`.

> A tool that declares `readOnlyHint: true` MUST NOT change state.

### 33. MWS-ANN-2 (MUST)

**Applies when:** the server offers a tool that declares `destructiveHint: false` and does not declare `readOnlyHint: true`.

> A tool that declares `destructiveHint: false` MUST NOT delete an object, and MUST NOT remove or replace data that the caller's arguments did not name.

### 34. MWS-ANN-3 (MUST)

**Applies when:** the server offers a tool that declares `idempotentHint: true` and does not declare `readOnlyHint: true`.

> A tool that declares `idempotentHint: true` MUST have no further effect when it is called again with the same arguments.

### 35. MWS-ANN-4 (SHOULD)

**Applies when:** the server offers a tool.

> A server SHOULD declare `readOnlyHint` explicitly on every tool and `destructiveHint` explicitly on every tool that does not declare `readOnlyHint: true`.

### 36. MWS-ANN-5 (SHOULD)

**Applies when:** the server offers a tool that declares `destructiveHint: false` and does not declare `readOnlyHint: true`.

> A tool that declares `destructiveHint: false` SHOULD perform only additive updates, as the MCP schema states.

## SEC: Credentials in results

### 37. MWS-SEC-1 (MUST)

**Applies when:** the server offers a tool, for every credential other than a credential that the tool exists to issue and the caller asked for.

> A tool result, whether it reports success or an error, MUST NOT contain a credential, including a token, a secret, or a URL that carries a token or a signature.
