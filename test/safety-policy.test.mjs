import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyBrowserAction,
  evaluateSafetyPolicy,
} from "../runtime/safety-policy.mjs";

test("safety policy classifies payment-looking clicks as payment actions", () => {
  const categories = classifyBrowserAction({
    type: "click",
    target: { selector: "button.pay" },
  });

  assert.deepEqual(categories, ["click", "payment"]);
});

test("safety policy classifies file chooser writes as uploads", () => {
  const categories = classifyBrowserAction({
    type: "filechooser.setFiles",
    target: { selector: "input[type=file]" },
  });

  assert.deepEqual(categories, ["upload"]);
});

test("safety policy returns matching confirmation mode for action categories", () => {
  const safety = evaluateSafetyPolicy({
    policy: {
      mode: "always-confirm",
      actions: ["payment"],
    },
    action: {
      type: "click",
      target: { selector: "button.pay" },
    },
  });

  assert.deepEqual(safety, {
    level: "always-confirm",
    reason: "policy matched payment",
    policyAction: "payment",
  });
});

test("safety policy respects domain constraints", () => {
  const policy = {
    mode: "always-confirm",
    domains: ["example.com"],
    actions: ["click"],
  };

  assert.equal(evaluateSafetyPolicy({
    policy,
    action: { type: "click", url: "https://safe.test/settings" },
  }), null);
  assert.deepEqual(evaluateSafetyPolicy({
    policy,
    action: { type: "click", url: "https://app.example.com/settings" },
  }), {
    level: "always-confirm",
    reason: "policy matched click",
    policyAction: "click",
  });
});
