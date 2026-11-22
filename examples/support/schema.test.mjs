// The inboxes in ./data/ were labeled under one exact wording of the questions in schema.ts. The
// example reuses those labels, so the wording must not drift: a schema's version is a hash of its
// wording, and this pins it. If you reword a question, the stored labels no longer answer it:
// label the inboxes again (or `upgrade` them) and then change the version here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { support } from "./schema.ts";

test("the example's schema asks the questions the stored labels answer", () => {
  assert.equal(support.id, "support@04043ab6a5");
  assert.equal(support.gates.feature_request, 0.7);
  assert.equal(support.signals.length, 21);
});
