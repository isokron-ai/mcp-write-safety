// The backend's input rules for the strict-input feature (design rules 5 and
// 10). Off in profile 0.1, whose backend accepts any Idempotency-Key header.

import { findIllFormedString } from "../digest.js";
import { ApiError } from "./store.js";

/** The idempotency-key format: the MCP tools' own (8 to 128 of A-Z a-z 0-9 . _ : -). */
export const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export interface InputRules {
  /** Refuses a key that is present and not in the key format (400 bad_idempotency_key). */
  checkKey(key: string | undefined): void;
  /** Refuses a body holding a string, or a member name, that is not well-formed Unicode (400 not_well_formed). */
  checkStrings(body: unknown): void;
}

export const correctInputRules: InputRules = {
  checkKey(key) {
    if (key === undefined) return;
    if (!KEY_PATTERN.test(key)) {
      throw new ApiError(400, "bad_idempotency_key", "Idempotency-Key must be 8 to 128 characters from A-Z a-z 0-9 . _ : -", { field: "Idempotency-Key" });
    }
  },
  checkStrings(body) {
    const at = findIllFormedString(body);
    if (at !== undefined) {
      throw new ApiError(400, "not_well_formed", `the string at ${at} is not well-formed Unicode (a lone surrogate); nothing was written`, { field: at });
    }
  },
};
