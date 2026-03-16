import { z } from "zod";
import { newPage, safeWait } from "../lib/browser.js";
import { scoreOpportunity } from "../lib/scorer.js";
import { PORTAL_KEYWORDS } from "../lib/config.js";

// OpenGov Procurement — used by many FL counties and cities
// URL pattern: procurement.opengov.com/portal/{agency-slug}/project-list
// Free vendor registration, consistent URL structure across all agencies
// Known FL users: Pinellas County, Orange County, City of St. Petersburg, etc.

const OPENGOV_FL_AGENCIES = [
  { slug: "pinellascounty", name: "Pinellas County" },
  { slug: "orangecountyfl", name: "Orange County" },
  { slug: "cityofstpetersburg", name: "City of St. Petersburg" },
  { slug: "cityofclearwater", name: "City of Clearwater" },
  { slug: "cityoflargo", name: "City of Largo" },
  { slug: "cityofsarasota", name: "City of Sarasota" },
  { slug: "cityofnorthport", name: "City of North Port" },
  { slug: "cityofdelraybeach", name: "City of Delray Beach" },
  { slug: "cityofcoconutcreek", name: "City of Coconut Creek" },
  { slug: "cityofdavie", name: "City of Davie" },
  { slug: "cityofplantation", name: "City of Plantation" },
  { slug: "cityofsunrise", name: "City of Sunrise" },
  { slug: "cityofwestpalmbeach", name: "City of West Palm Beach" },
  { slug: "cityofboyntonbeach", name: "City of Boynton Beach" },
  { slug: "cityofgainesville", name: "City of Gainesville" },
  { slug: "cityoftallahassee", name: "City of Tallahassee" },
  { slug: "cityofocala", name: "City of Ocala" },
  { slug: "cityoflakeland", name: "City of Lakeland" },
  { slug: "cityofwinterpark", name: "City of Winter Park" },
  { slug: "cityofdunedin", name: "City of Dunedin" },
  { slug: "cityofseminole", name: "City of Seminole" },
  { slug: "cityoftarponsprings", name: "City of Tarpon Springs" },
  { slug: "cityofpalmettobay", name: "Village of Palmetto Bay" },
  { slug: "manatee-county", name: "Manatee County" },
];

async function scrapeOpenGovAgency(page, agency) {
  const results = [];
  const url = `https://procurement.opengov.com/portal/${agency.slug}/project-list`;

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForTimeout(3000);

    // Check if page loaded (some agency slugs may not exist)
    const pageContent = await page.evaluate(() => document.body?.innerText?.length || 0);
    if (pageContent < 100) return results;

    // Extract project listings — OpenGov uses React with consistent structure
    const projects = await page.evaluate((agencyName) => {
      const items = [];
      // OpenGov lists projects in card/row format
      const cards = document.querySelectorAll(
        "[class*='project'], [class*='card'], [class*='solicitation'], [class*='listing'], table tbody tr, [class*='row'][class*='item'], [class*='MuiCard'], [class*='MuiPaper'], [class*='bid']"
      );

      cards.forEach((card) => {
        const titleEl = card.querySelector(
          "a, h2, h3, h4, [class*='title'], [class*='name'], [class*='Title']"
        );
        const statusEl = card.querySelector(
          "[class*='status'], [class*='Status'], [class*='badge'], [class*='chip']"
        );
        const dateEl = card.querySelector(
          "[class*='date'], [class*='Date'], [class*='deadline'], [class*='due'], time"
        );
        const descEl = card.querySelector(
          "[class*='description'], [class*='desc'], [class*='summary'], p"
        );
        const link = card.querySelector("a[href]");
        const idEl = card.querySelector("[class*='id'], [class*='number'], [class*='ref']");

        if (titleEl?.textContent?.trim() && titleEl.textContent.trim().length > 3) {
          items.push({
            title: titleEl.textContent.trim(),
            agency: agencyName,
            status: statusEl?.textContent?.trim() || "",
            deadline: dateEl?.textContent?.trim() || "",
            description: descEl?.textContent?.trim()?.substring(0, 300) || "",
            refNumber: idEl?.textContent?.trim() || "",
            url: link?.href || "",
          });
        }
      });
      return items;
    }, agency.name);

    for (const p of projects) {
      // Skip closed/awarded
      const status = (p.status || "").toLowerCase();
      if (status.includes("closed") || status.includes("awarded") || status.includes("cancelled") || status.includes("canceled")) continue;

      results.push({
        id: `opengov-${agency.slug}-${p.refNumber || p.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
        title: p.title,
        platform: "OpenGov",
        agency: p.agency,
        state: "FL",
        status: p.status || "open",
        deadline: p.deadline || null,
        description: p.description || "",
        url: p.url || url,
        type: "Solicitation",
      });
    }
  } catch {
    // Agency portal may not exist or be down — skip silently
  }

  return results;
}

async function scrapeOpenGov(keywords) {
  const page = await newPage();
  const results = [];

  try {
    for (const agency of OPENGOV_FL_AGENCIES) {
      const agencyResults = await scrapeOpenGovAgency(page, agency);
      results.push(...agencyResults);
    }
  } finally {
    await page.close();
  }

  // Filter by keywords if any match in title/description
  const keywordLower = (keywords || PORTAL_KEYWORDS).map((k) => k.toLowerCase());
  const filtered = results.filter((r) => {
    const text = `${r.title} ${r.description}`.toLowerCase();
    // If no specific keywords are MPA-relevant in this result, still include it
    // The scorer will handle relevance
    return true;
  });

  // Dedupe
  const seen = new Set();
  return filtered.filter((r) => {
    const key = `${r.agency}-${r.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function registerOpenGovTools(server) {
  server.tool(
    "opengov_scan",
    "Scan OpenGov Procurement portals for FL procurement opportunities. Covers Pinellas County, Orange County, St. Petersburg, Clearwater, Lakeland, and 20+ other FL cities/counties that use the OpenGov platform.",
    {
      keywords: z.array(z.string()).optional().describe("Custom keywords. Defaults to MPA's standard list."),
      agencies: z.array(z.string()).optional().describe("Specific agency slugs to scan (e.g. 'pinellascounty'). Defaults to all tracked FL agencies."),
    },
    async (params) => {
      const opps = await scrapeOpenGov(params.keywords || PORTAL_KEYWORDS);
      opps.forEach((o) => {
        const s = scoreOpportunity(o);
        o.score = s.score;
        o.relevance = s.relevance;
        o.scoreReasons = s.reasons;
      });
      opps.sort((a, b) => b.score - a.score);

      if (!opps.length) return { content: [{ type: "text", text: "No OpenGov opportunities found." }] };
      const lines = opps.map(
        (o) =>
          `[${o.relevance} | Score ${o.score}] **${o.title}**\n  Agency: ${o.agency} | Deadline: ${o.deadline || "N/A"}\n  ${o.url}`
      );
      return {
        content: [
          {
            type: "text",
            text: `## OpenGov Procurement Scan\nFound ${opps.length} opportunities across ${OPENGOV_FL_AGENCIES.length} FL agencies:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );

  server.tool(
    "opengov_agency_list",
    "List all FL agencies tracked on OpenGov Procurement. Shows portal URLs for each agency.",
    {},
    async () => {
      const lines = OPENGOV_FL_AGENCIES.map(
        (a) => `- **${a.name}** → https://procurement.opengov.com/portal/${a.slug}/project-list`
      );
      return {
        content: [
          {
            type: "text",
            text: `## OpenGov FL Agencies (${OPENGOV_FL_AGENCIES.length})\n\n${lines.join("\n")}`,
          },
        ],
      };
    }
  );
}

export async function runOpenGovScan(keywords) {
  const opps = await scrapeOpenGov(keywords || PORTAL_KEYWORDS);
  return opps.map((o) => {
    const s = scoreOpportunity(o);
    return { ...o, ...s };
  });
}
