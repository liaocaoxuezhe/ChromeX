const PAYMENT_PATTERN = /pay|payment|purchase|checkout|buy|order|subscribe|付款|支付|购买|结账|下单/i;

export function classifyBrowserAction(action = {}) {
  if (action.type === "filechooser.setFiles" || action.type === "upload") {
    return ["upload"];
  }
  if (action.type === "download") return ["download"];
  if (action.type === "send-message") return ["send-message"];

  const categories = [];
  if (isClickAction(action.type)) {
    categories.push("click");
    if (looksLikePaymentTarget(action.target)) {
      categories.push("payment");
    }
  }
  if (action.type === "fill") categories.push("fill");
  if (action.type === "press" || action.type === "cua.key" || action.type === "cua.type") {
    categories.push("keyboard");
  }
  if (action.type === "cua.drag") categories.push("drag");
  return categories;
}

export function evaluateSafetyPolicy({ policy, action } = {}) {
  if (!policy || policy.mode === "no-confirm") return null;
  if (!domainMatches(policy.domains, action?.url)) return null;

  const categories = classifyBrowserAction(action);
  const policyActions = policy.actions || [];
  const matchedAction = policyActions.length === 0
    ? categories[0]
    : policyActions.find((item) => categories.includes(item));
  if (!matchedAction) return null;

  return {
    level: policy.mode,
    reason: `policy matched ${matchedAction}`,
    policyAction: matchedAction,
  };
}

function isClickAction(type) {
  return type === "click" || type === "cua.click" || type === "dom_cua.click";
}

function looksLikePaymentTarget(target = {}) {
  return PAYMENT_PATTERN.test([
    target.selector,
    target.text,
    target.ariaLabel,
    target.name,
  ].filter(Boolean).join(" "));
}

function domainMatches(domains, url) {
  if (!domains || domains.length === 0) return true;
  if (!url) return false;
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}
