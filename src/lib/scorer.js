import { NAICS_CODES } from "./config.js";

const HIGH_VALUE_KEYWORDS = [
  "printing",
  "mail",
  "presort",
  "eddm",
  "fulfillment",
  "direct mail",
  "mailing",
  "utility billing",
  "statement",
  "mailroom",
  "courier",
  "print and mail",
  "document processing",
];

export function scoreOpportunity(opp) {
  let score = 0;
  const reasons = [];
  const title = (opp.title || "").toLowerCase();
  const desc = (opp.description || "").toLowerCase();
  const text = `${title} ${desc}`;

  // NAICS match
  if (opp.naicsCode && NAICS_CODES.includes(opp.naicsCode)) {
    score += 30;
    reasons.push(`NAICS match (${opp.naicsCode})`);
  }

  // Florida location
  const state = opp.state || opp.popState || "";
  if (state.toUpperCase() === "FL" || text.includes("florida")) {
    score += 25;
    reasons.push("Florida location");
  }

  // Keyword relevance
  for (const kw of HIGH_VALUE_KEYWORDS) {
    if (text.includes(kw)) {
      score += 15;
      reasons.push(`Keyword: "${kw}"`);
    }
  }

  // Active status
  if (opp.active === "Yes" || opp.status === "open" || opp.status === "active") {
    score += 10;
    reasons.push("Active/Open");
  }

  // Deadline urgency
  if (opp.deadline) {
    const dl = new Date(opp.deadline);
    const now = new Date();
    const daysUntil = (dl - now) / (1000 * 60 * 60 * 24);
    if (daysUntil > 0 && daysUntil <= 7) {
      score += 30;
      reasons.push(`Urgent: ${Math.ceil(daysUntil)} days left`);
    } else if (daysUntil > 0 && daysUntil <= 14) {
      score += 20;
      reasons.push(`Upcoming: ${Math.ceil(daysUntil)} days left`);
    } else if (daysUntil <= 0) {
      score -= 20;
      reasons.push("Deadline passed");
    }
  }

  // Set-aside bonus
  const setAside = (opp.setAside || "").toLowerCase();
  if (
    setAside.includes("small") ||
    setAside.includes("sdvosb") ||
    setAside.includes("veteran") ||
    setAside.includes("vosb")
  ) {
    score += 10;
    reasons.push(`Set-aside: ${opp.setAside}`);
  }

  // Solicitation type bonus (more actionable)
  const type = (opp.type || "").toLowerCase();
  if (type.includes("solicitation") || type.includes("rfp") || type.includes("itb")) {
    score += 10;
    reasons.push("Solicitation/RFP");
  }

  // Estimated value bonus
  if (opp.estimatedValue && opp.estimatedValue > 50000) {
    score += 10;
    reasons.push(`Est. value > $50K`);
  }

  // Cap score to avoid runaway from many keyword matches
  const relevance =
    score >= 80 ? "HIGH" : score >= 40 ? "MEDIUM" : score > 0 ? "LOW" : "NONE";

  return { score, relevance, reasons };
}
