import { z } from "zod";
import { SAM_API_KEY, NAICS_CODES, PSC_CODES, KEYWORDS } from "../lib/config.js";
import { scoreOpportunity } from "../lib/scorer.js";

const BASE_URL = "https://api.sam.gov";

function fmtDate(d) {
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

async function samFetch(path, params = {}) {
  if (!SAM_API_KEY) throw new Error("SAM_GOV_API_KEY not set in .env");
  const url = new URL(path, BASE_URL);
  url.searchParams.set("api_key", SAM_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`SAM.gov API ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

function normalizeOpp(opp) {
  const pop = opp.placeOfPerformance;
  return {
    id: opp.noticeId,
    title: opp.title,
    platform: "SAM.gov",
    type: opp.type || opp.baseType,
    naicsCode: opp.naicsCode,
    solicitationNumber: opp.solicitationNumber,
    agency: opp.fullParentPathName,
    state: pop?.state?.code || "",
    deadline: opp.responseDeadLine || null,
    postedDate: opp.postedDate,
    setAside: opp.setAside || opp.setAsideCode || "",
    active: opp.active,
    url: opp.uiLink || `https://sam.gov/opp/${opp.noticeId}/view`,
    contact: opp.pointOfContact?.[0]
      ? `${opp.pointOfContact[0].fullName || ""} (${opp.pointOfContact[0].email || ""})`
      : "",
    awardAmount: opp.award?.amount || null,
    awardee: opp.award?.awardee?.name || null,
  };
}

export function registerSamGovTools(server) {
  // ---- search_opportunities ----
  server.tool(
    "sam_search",
    "Search SAM.gov federal contract opportunities by keyword, NAICS, state, set-aside, date range, and procurement type.",
    {
      keyword: z.string().optional().describe("Search keyword for title"),
      naics_code: z.string().optional().describe("NAICS code (e.g. 323111)"),
      procurement_type: z.enum(["solicitation","presolicitation","sources_sought","award","combined_synopsis","special_notice",""]).optional(),
      set_aside: z.string().optional().describe("Set-aside code (SBA, SDVOSBC, 8A, HZC)"),
      state: z.string().optional().describe("State code (e.g. FL)"),
      organization_name: z.string().optional(),
      classification_code: z.string().optional().describe("PSC code (e.g. S222)"),
      days_back: z.number().optional().describe("Days back to search (default 30)"),
      limit: z.number().min(1).max(1000).optional(),
    },
    async (params) => {
      const ptypeMap = { solicitation:"o", presolicitation:"p", sources_sought:"r", award:"a", combined_synopsis:"k", special_notice:"s" };
      const daysBack = params.days_back || 30;
      const from = new Date(); from.setDate(from.getDate() - daysBack);
      const apiParams = { postedFrom: fmtDate(from), postedTo: fmtDate(new Date()), limit: params.limit || 50 };
      if (params.keyword) apiParams.title = params.keyword;
      if (params.naics_code) apiParams.ncode = params.naics_code;
      if (params.procurement_type && ptypeMap[params.procurement_type]) apiParams.ptype = ptypeMap[params.procurement_type];
      if (params.set_aside) apiParams.typeOfSetAside = params.set_aside;
      if (params.state) apiParams.state = params.state;
      if (params.organization_name) apiParams.organizationName = params.organization_name;
      if (params.classification_code) apiParams.ccode = params.classification_code;

      const data = await samFetch("/opportunities/v2/search", apiParams);
      const opps = (data.opportunitiesData || []).map(normalizeOpp);
      opps.forEach(o => { const s = scoreOpportunity(o); o.score = s.score; o.relevance = s.relevance; o.scoreReasons = s.reasons; });
      opps.sort((a, b) => b.score - a.score);

      if (!opps.length) return { content: [{ type: "text", text: `No SAM.gov opportunities found.` }] };
      const lines = opps.map(o => `[${o.relevance} | Score ${o.score}] **${o.title}**\n  Sol#: ${o.solicitationNumber || "N/A"} | NAICS: ${o.naicsCode || "N/A"} | ${o.state || "N/A"}\n  Agency: ${o.agency || "N/A"}\n  Deadline: ${o.deadline ? new Date(o.deadline).toLocaleDateString() : "N/A"} | Set-Aside: ${o.setAside || "None"}\n  Contact: ${o.contact || "N/A"}\n  ${o.url}`);
      return { content: [{ type: "text", text: `Found ${data.totalRecords || opps.length} opportunities (showing ${opps.length}):\n\n${lines.join("\n\n")}` }] };
    }
  );

  // ---- sam_entity_search ----
  server.tool(
    "sam_entity_search",
    "Look up SAM.gov registered entities (businesses) by name, UEI, CAGE, NAICS, state, or business type.",
    {
      name: z.string().optional().describe("Business name"),
      uei: z.string().optional().describe("UEI (12-char)"),
      cage_code: z.string().optional(),
      naics_code: z.string().optional(),
      state: z.string().optional(),
      business_type: z.string().optional().describe("2X=SDVOSB, 23=WOSB, A2=8(a), QF=HUBZone"),
      q: z.string().optional().describe("Free text search"),
    },
    async (params) => {
      const apiParams = { registrationStatus: "A", includeSections: "entityRegistration,coreData,assertions,pointsOfContact" };
      if (params.name) apiParams.legalBusinessName = params.name;
      if (params.uei) apiParams.ueiSAM = params.uei;
      if (params.cage_code) apiParams.cageCode = params.cage_code;
      if (params.naics_code) apiParams.naicsCodeAny = params.naics_code;
      if (params.state) apiParams.physicalAddressProvinceOrStateCode = params.state;
      if (params.business_type) apiParams.businessTypeCode = params.business_type;
      if (params.q) apiParams.q = params.q;
      const data = await samFetch("/entity-information/v3/entities", apiParams);
      const entities = data.entityData || [];
      if (!entities.length) return { content: [{ type: "text", text: "No entities found." }] };
      const lines = entities.map(e => {
        const r = e.entityRegistration || {};
        const c = e.coreData || {};
        const addr = c.physicalAddress || {};
        return `**${r.legalBusinessName}** (UEI: ${r.ueiSAM}, CAGE: ${r.cageCode || "N/A"})\n  Status: ${r.registrationStatus} | ${r.purposeOfRegistrationDesc || "N/A"}\n  Address: ${[addr.addressLine1, addr.city, addr.stateOrProvinceCode, addr.zipCode].filter(Boolean).join(", ")}\n  Expiration: ${r.expirationDate || "N/A"}`;
      });
      return { content: [{ type: "text", text: `Found ${data.totalRecords || entities.length} entities:\n\n${lines.join("\n\n")}` }] };
    }
  );

  // ---- mpa_sam_scan ----
  server.tool(
    "sam_mpa_scan",
    "Run MPA-optimized SAM.gov scan across all 6 NAICS codes, 2 PSC codes, and 10 keywords with relevance scoring. This is the comprehensive federal procurement sweep.",
    {
      days_back: z.number().optional().describe("Days back (default 14)"),
      states: z.string().optional().describe("Comma-separated state codes to prioritize (default FL). Use ALL for nationwide."),
    },
    async (params) => {
      const daysBack = Math.min(params.days_back || 14, 365);
      const from = new Date(); from.setDate(from.getDate() - daysBack);
      const postedFrom = fmtDate(from);
      const postedTo = fmtDate(new Date());
      const ptypes = ["o", "p", "r", "k", "s"];
      const allOpps = new Map();

      // Search by NAICS
      for (const naics of NAICS_CODES) {
        for (const ptype of ptypes) {
          try {
            const d = await samFetch("/opportunities/v2/search", { ncode: naics, ptype, postedFrom, postedTo, limit: 100 });
            for (const o of d.opportunitiesData || []) if (!allOpps.has(o.noticeId)) allOpps.set(o.noticeId, normalizeOpp(o));
          } catch {}
        }
      }
      // Search by PSC
      for (const psc of PSC_CODES) {
        try {
          const d = await samFetch("/opportunities/v2/search", { ccode: psc, postedFrom, postedTo, limit: 100 });
          for (const o of d.opportunitiesData || []) if (!allOpps.has(o.noticeId)) allOpps.set(o.noticeId, normalizeOpp(o));
        } catch {}
      }
      // Search by keywords
      for (const kw of KEYWORDS) {
        try {
          const d = await samFetch("/opportunities/v2/search", { title: kw, postedFrom, postedTo, limit: 50 });
          for (const o of d.opportunitiesData || []) if (!allOpps.has(o.noticeId)) allOpps.set(o.noticeId, normalizeOpp(o));
        } catch {}
      }

      const scored = [...allOpps.values()].map(o => { const s = scoreOpportunity(o); return { ...o, ...s }; });
      scored.sort((a, b) => b.score - a.score);

      if (!scored.length) return { content: [{ type: "text", text: `No SAM.gov opportunities found in last ${daysBack} days.` }] };
      const top = scored.slice(0, 50);
      const lines = top.map(o => `[${o.relevance} | Score ${o.score}] **${o.title}**\n  NAICS: ${o.naicsCode || "N/A"} | ${o.state || "N/A"} | Deadline: ${o.deadline ? new Date(o.deadline).toLocaleDateString() : "N/A"}\n  Agency: ${o.agency || "N/A"} | Set-Aside: ${o.setAside || "None"}\n  ${o.url}\n  Scoring: ${o.reasons.join(", ")}`);
      return { content: [{ type: "text", text: `## SAM.gov MPA Scan\nTotal unique: ${scored.length} | Showing top ${top.length}\nDate range: ${postedFrom} - ${postedTo}\n\n${lines.join("\n\n")}` }] };
    }
  );
}

// Export for aggregator use
export async function runSamScan(daysBack = 14) {
  const from = new Date(); from.setDate(from.getDate() - daysBack);
  const postedFrom = fmtDate(from);
  const postedTo = fmtDate(new Date());
  const ptypes = ["o", "p", "r", "k", "s"];
  const allOpps = new Map();
  for (const naics of NAICS_CODES) {
    for (const ptype of ptypes) {
      try {
        const d = await samFetch("/opportunities/v2/search", { ncode: naics, ptype, postedFrom, postedTo, limit: 100 });
        for (const o of d.opportunitiesData || []) if (!allOpps.has(o.noticeId)) allOpps.set(o.noticeId, normalizeOpp(o));
      } catch {}
    }
  }
  for (const psc of PSC_CODES) {
    try {
      const d = await samFetch("/opportunities/v2/search", { ccode: psc, postedFrom, postedTo, limit: 100 });
      for (const o of d.opportunitiesData || []) if (!allOpps.has(o.noticeId)) allOpps.set(o.noticeId, normalizeOpp(o));
    } catch {}
  }
  for (const kw of KEYWORDS) {
    try {
      const d = await samFetch("/opportunities/v2/search", { title: kw, postedFrom, postedTo, limit: 50 });
      for (const o of d.opportunitiesData || []) if (!allOpps.has(o.noticeId)) allOpps.set(o.noticeId, normalizeOpp(o));
    } catch {}
  }
  return [...allOpps.values()].map(o => { const s = scoreOpportunity(o); return { ...o, ...s, platform: "SAM.gov" }; });
}
