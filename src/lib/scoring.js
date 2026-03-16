/**
 * MPA Procurement Go/No-Go Scoring Engine
 *
 * Implements the scoring algorithm from procurement-scoring.md.
 * MPA Fit (0-50) + ROI (0-50) = Total Score (0-100).
 * Thresholds: BID ≥75, REVIEW 50-74, SKIP <50.
 */

// Direct-hit keywords (25 pts)
const DIRECT_HIT = [
  "mail", "print", "direct mail", "mailing services", "letter shop",
  "eddm", "every door direct mail", "bulk mail", "data processing",
  "inkjet", "fulfillment", "statement processing", "presort",
  "print and mail", "mailroom", "utility billing", "mail processing",
  "printing services", "mailing", "courier mail", "inserting",
  "variable data", "postcard", "newsletter printing", "envelope",
  "mail sorting", "address", "tabbing", "folding", "metering",
];

// Adjacent keywords (15 pts)
const ADJACENT = [
  "marketing", "communications", "printing supplies", "paper",
  "document", "forms", "publication", "signage", "copying",
  "reprographic", "bindery", "laminating", "wide format",
];

// Tangential keywords (5 pts)
const TANGENTIAL = [
  "office supplies", "IT print management", "managed print",
  "copier", "MFP", "multifunction",
];

// Florida and neighbor states
const FLORIDA = ["fl", "florida"];
const NEIGHBORS = ["ga", "georgia", "al", "alabama", "sc", "south carolina", "tn", "tennessee"];
const SOUTHEAST = ["nc", "north carolina", "ms", "mississippi", "la", "louisiana"];

/**
 * Score an opportunity.
 * @param {object} opp - Opportunity object with at least:
 *   - title {string}
 *   - description {string} (optional, improves accuracy)
 *   - agency {string}
 *   - state {string}
 *   - deadline {string} (date string)
 *   - estValue {string|number} (dollar amount or "Unknown")
 *   - contractType {string} (optional: "multi-year", "one-time", "recurring", etc.)
 *   - competition {string} (optional: "small-business", "limited", "open", "incumbent")
 *   - complexity {string} (optional: "low", "medium", "high")
 * @returns {object} { score, mpaFit, mpaFitScore, roi, roiScore, decision, reasons }
 */
export function scoreOpportunity(opp) {
  const text = `${opp.title || ""} ${opp.description || ""} ${opp.agency || ""}`.toLowerCase();

  // ---- MPA Fit Score (0-50) ----
  let serviceMatch = 0;
  if (DIRECT_HIT.some((kw) => text.includes(kw))) {
    serviceMatch = 25;
  } else if (ADJACENT.some((kw) => text.includes(kw))) {
    serviceMatch = 15;
  } else if (TANGENTIAL.some((kw) => text.includes(kw))) {
    serviceMatch = 5;
  }

  let geography = 2; // default: national/other
  const stateStr = (opp.state || "").toLowerCase().trim();
  if (FLORIDA.some((s) => stateStr.includes(s))) {
    geography = 15;
  } else if (NEIGHBORS.some((s) => stateStr.includes(s))) {
    geography = 10;
  } else if (SOUTHEAST.some((s) => stateStr.includes(s))) {
    geography = 5;
  } else if (stateStr === "" || stateStr === "n/a") {
    geography = 5; // unknown = benefit of doubt
  }

  let sizeScore = 5; // default: unknown
  const val = parseValue(opp.estValue);
  if (val !== null) {
    if (val >= 10000 && val <= 500000) sizeScore = 10;
    else if (val > 500000 && val <= 2000000) sizeScore = 5;
    else if (val < 10000) sizeScore = 2;
    else sizeScore = 1; // >$2M
  }

  const mpaFitScore = serviceMatch + geography + sizeScore;

  // ---- ROI Score (0-50) ----
  let deadlineScore = 10; // default
  if (opp.deadline) {
    const daysOut = daysUntil(opp.deadline);
    if (daysOut === null || isNaN(daysOut)) {
      deadlineScore = 10; // can't parse
    } else if (daysOut < 0) {
      deadlineScore = 0; // passed
    } else if (daysOut < 7) {
      deadlineScore = 2;
    } else if (daysOut < 14) {
      deadlineScore = 5;
    } else if (daysOut <= 21) {
      deadlineScore = 10;
    } else {
      deadlineScore = 15;
    }
  }

  let competitionScore = 5; // default: open
  const comp = (opp.competition || "").toLowerCase();
  if (comp.includes("small business") || comp.includes("set-aside") || comp.includes("sole source") || comp.includes("limited")) {
    competitionScore = 10;
  } else if (comp.includes("incumbent") || comp.includes("large")) {
    competitionScore = 2;
  }

  let contractScore = 5; // default: one-time
  const ct = (opp.contractType || opp.title || "").toLowerCase();
  if (ct.includes("idiq") || ct.includes("bpa") || ct.includes("multi-year") || ct.includes("annual") || ct.includes("recurring") || ct.includes("blanket")) {
    contractScore = 15;
  } else if (ct.includes("renewal") || ct.includes("option year") || ct.includes("with option")) {
    contractScore = 10;
  }

  let effortScore = 7; // default: medium
  const cmplx = (opp.complexity || "").toLowerCase();
  if (cmplx === "low" || cmplx.includes("standard")) {
    effortScore = 10;
  } else if (cmplx === "high" || cmplx.includes("complex")) {
    effortScore = 3;
  }
  // Also infer from service match: direct hit = likely standard work
  if (effortScore === 7 && serviceMatch === 25) effortScore = 8;

  const roiScore = deadlineScore + competitionScore + contractScore + effortScore;

  // ---- Total ----
  const score = mpaFitScore + roiScore;

  // Decision
  let decision;
  if (score >= 75) decision = "BID";
  else if (score >= 50) decision = "REVIEW";
  else decision = "SKIP";

  // Ratings
  const mpaFit = mpaFitScore >= 35 ? "HIGH" : mpaFitScore >= 20 ? "MEDIUM" : "LOW";
  const roi = roiScore >= 35 ? "HIGH" : roiScore >= 20 ? "MEDIUM" : "LOW";

  // Auto-generate reasons
  const reasons = buildReasons(opp, decision, serviceMatch, geography, sizeScore, deadlineScore, val);

  return { score, mpaFitScore, mpaFit, roiScore, roi, decision, reasons };
}

/**
 * Parse a dollar value string into a number.
 * Handles "$150K", "$1.2M", "$150,000", "150000", "Unknown".
 */
function parseValue(raw) {
  if (!raw || raw === "Unknown" || raw === "N/A" || raw === "TBD") return null;
  let s = String(raw).replace(/[^0-9.KMBkmb]/g, "");
  if (!s) return null;
  const multipliers = { k: 1000, m: 1000000, b: 1000000000 };
  const lastChar = s.slice(-1).toLowerCase();
  if (multipliers[lastChar]) {
    return parseFloat(s.slice(0, -1)) * multipliers[lastChar];
  }
  return parseFloat(s) || null;
}

/**
 * Calculate days until a deadline date string.
 */
function daysUntil(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    return Math.ceil((d - now) / (1000 * 60 * 60 * 24));
  } catch {
    return null;
  }
}

/**
 * Build a concise 1-2 sentence reason string.
 */
function buildReasons(opp, decision, serviceMatch, geography, sizeScore, deadlineScore, val) {
  const parts = [];

  // Service match description
  if (serviceMatch === 25) parts.push("Direct service match");
  else if (serviceMatch === 15) parts.push("Adjacent service match");
  else if (serviceMatch === 5) parts.push("Tangential service match");
  else parts.push("No service match");

  // Geography
  if (geography >= 15) parts.push("FL");
  else if (geography >= 10) parts.push("neighboring state");
  else if (geography >= 5) parts.push("Southeast");

  // Value
  if (val !== null) {
    if (val >= 1000000) parts.push(`$${(val / 1000000).toFixed(1)}M est.`);
    else if (val >= 1000) parts.push(`$${Math.round(val / 1000)}K est.`);
    else parts.push(`$${val} est.`);
  } else {
    parts.push("value TBD");
  }

  // Deadline urgency
  if (deadlineScore === 0) parts.push("deadline passed");
  else if (deadlineScore <= 2) parts.push("deadline < 7 days");
  else if (deadlineScore <= 5) parts.push("tight deadline");

  // Agency context
  const agency = opp.agency || "";
  const title = opp.title || "";

  let summary;
  if (decision === "BID") {
    summary = `${parts.join(", ")}. ${title.slice(0, 60)} for ${agency.slice(0, 40)}.`;
  } else if (decision === "REVIEW") {
    summary = `${parts.join(", ")}. Worth investigating: ${title.slice(0, 50)}.`;
  } else {
    summary = `${parts.join(", ")}. ${serviceMatch === 0 ? "No clear service match." : "Low overall fit."}`;
  }

  return summary.replace(/\.\./g, ".").trim();
}

export { parseValue, daysUntil };
