import { z } from "zod";
import { newPage, safeWait, getText } from "../lib/browser.js";
import { scoreOpportunity } from "../lib/scorer.js";
import { PORTAL_KEYWORDS } from "../lib/config.js";

// Direct FL County Procurement Portals
// Many counties run their own procurement pages outside any third-party platform.
// These are often simple HTML pages with tables — high value because less competition.

const FL_COUNTY_PORTALS = [
  {
    name: "Polk County",
    url: "https://polkfl.gov/business/procurement",
    type: "html-table",
    selectors: {
      // Polk lists bids in multiple tables on the page
      table: "table",
      title: "td:nth-child(2), td:nth-child(2) a",
      bidNum: "td:first-child",
      date: "td:nth-child(3), td:last-child",
    },
  },
  {
    name: "Hillsborough County",
    url: "https://www.hcfl.gov/business/procurement-services/current-solicitations",
    type: "html-list",
    selectors: {
      item: "table tbody tr, [class*='item'], [class*='row'], [class*='listing'], .views-row, article",
      title: "a, [class*='title'], td:first-child a, td:nth-child(2) a",
      date: "[class*='date'], td:nth-child(3), time",
    },
  },
  {
    name: "Pinellas County (direct)",
    url: "https://www.pinellascounty.org/purchase/current-bids.htm",
    type: "html-table",
    selectors: {
      table: "table",
      title: "td a, td:nth-child(2) a",
      bidNum: "td:first-child",
      date: "td:nth-child(3), td:last-child",
    },
  },
  {
    name: "Orange County",
    url: "https://www.ocfl.net/SellingtoOrangeCounty/CurrentSolicitations.aspx",
    type: "html-list",
    selectors: {
      item: "table tbody tr, [class*='item'], .rgRow, .rgAltRow, [class*='row']",
      title: "a, [class*='title'], td:nth-child(2) a",
      date: "[class*='date'], td:nth-child(3), td:nth-child(4)",
    },
  },
  {
    name: "Duval/Jacksonville",
    url: "https://www.coj.net/departments/finance/procurement",
    type: "html-list",
    selectors: {
      item: "table tbody tr, [class*='item'], [class*='listing'], .views-row, article, li",
      title: "a, [class*='title']",
      date: "[class*='date'], time",
    },
  },
  {
    name: "Volusia County",
    url: "https://www.volusia.org/services/government/purchasing-and-contracts/bid-opportunities.stml",
    type: "html-list",
    selectors: {
      item: "table tbody tr, [class*='item'], [class*='row'], li a",
      title: "a, [class*='title'], td:nth-child(2)",
      date: "[class*='date'], td:nth-child(3)",
    },
  },
  {
    name: "Brevard County",
    url: "https://www.brevardfl.gov/PurchasingAndContracts/Bids-Proposals",
    type: "html-list",
    selectors: {
      item: "table tbody tr, [class*='item'], [class*='row'], li",
      title: "a, [class*='title'], td:first-child a",
      date: "[class*='date'], td:nth-child(3)",
    },
  },
  {
    name: "Seminole County",
    url: "https://www.seminolecountyfl.gov/departments-services/purchasing-contracts/current-solicitations.stml",
    type: "html-list",
    selectors: {
      item: "table tbody tr, [class*='item'], [class*='row'], article",
      title: "a, [class*='title'], td:nth-child(2)",
      date: "[class*='date'], td:nth-child(3)",
    },
  },
  {
    name: "Osceola County",
    url: "https://www.osceola.org/agencies-departments/procurement/",
    type: "html-list",
    selectors: {
      item: "table tbody tr, [class*='item'], [class*='row'], [class*='listing']",
      title: "a, [class*='title']",
      date: "[class*='date'], time",
    },
  },
  {
    name: "Pasco County",
    url: "https://www.pascocountyfl.net/194/Current-Bids-RFPs",
    type: "html-list",
    selectors: {
      item: "table tbody tr, [class*='item'], [class*='row'], .listing-item",
      title: "a, [class*='title'], td:first-child a",
      date: "[class*='date'], td:nth-child(3)",
    },
  },
  {
    name: "Sarasota County",
    url: "https://www.scgov.net/government/procurement/bids",
    type: "html-list",
    selectors: {
      item: "table tbody tr, [class*='item'], [class*='row'], article",
      title: "a, [class*='title'], td:first-child",
      date: "[class*='date'], td:nth-child(3)",
    },
  },
  {
    name: "Manatee County",
    url: "https://www.mymanatee.org/departments/procurement_management/current_solicitations",
    type: "html-list",
    selectors: {
      item: "table tbody tr, [class*='item'], [class*='row'], article",
      title: "a, [class*='title'], td:first-child a",
      date: "[class*='date'], td:nth-child(3)",
    },
  },
];

async function scrapeCountyPortal(page, portal) {
  const results = [];

  try {
    await page.goto(portal.url, { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForTimeout(3000);

    // Generic extraction — works across most gov sites
    const items = await page.evaluate((portalInfo) => {
      const found = [];

      if (portalInfo.type === "html-table") {
        // Extract from all tables on the page
        const tables = document.querySelectorAll("table");
        tables.forEach((table) => {
          const rows = table.querySelectorAll("tbody tr, tr");
          rows.forEach((row, i) => {
            if (i === 0 && row.querySelector("th")) return; // Skip header row
            const cells = row.querySelectorAll("td");
            if (cells.length < 2) return;

            const titleCell = cells[1] || cells[0];
            const titleLink = titleCell?.querySelector("a");
            const title = titleLink?.textContent?.trim() || titleCell?.textContent?.trim() || "";
            const bidNum = cells[0]?.textContent?.trim() || "";
            const date = cells[2]?.textContent?.trim() || cells[cells.length - 1]?.textContent?.trim() || "";
            const url = titleLink?.href || "";

            if (title && title.length > 3 && !title.toLowerCase().includes("bid #") && !title.toLowerCase().includes("title")) {
              found.push({ title, bidNum, date, url });
            }
          });
        });
      } else {
        // html-list: Try multiple selectors for items
        const sels = portalInfo.selectors;
        const itemEls = document.querySelectorAll(sels.item);

        itemEls.forEach((el) => {
          const titleEl = el.querySelector(sels.title);
          const dateEl = el.querySelector(sels.date);
          const link = el.querySelector("a[href]");

          const title = titleEl?.textContent?.trim() || "";
          if (title && title.length > 5) {
            found.push({
              title,
              bidNum: "",
              date: dateEl?.textContent?.trim() || "",
              url: link?.href || "",
            });
          }
        });

        // Fallback: if no items found, try extracting all links that look like bid postings
        if (found.length === 0) {
          const allLinks = document.querySelectorAll("a[href]");
          allLinks.forEach((a) => {
            const text = a.textContent?.trim() || "";
            const href = a.href || "";
            if (
              text.length > 10 &&
              (href.includes("bid") || href.includes("rfp") || href.includes("solicitation") || href.includes("procurement")) &&
              !text.toLowerCase().includes("login") &&
              !text.toLowerCase().includes("register")
            ) {
              found.push({ title: text, bidNum: "", date: "", url: href });
            }
          });
        }
      }

      return found;
    }, portal);

    for (const item of items) {
      results.push({
        id: `county-${portal.name}-${item.bidNum || item.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
        title: item.title,
        platform: "FL County Direct",
        agency: portal.name,
        state: "FL",
        deadline: item.date || null,
        url: item.url || portal.url,
        type: "Solicitation",
        bidNumber: item.bidNum || "",
      });
    }
  } catch {
    // County page may be down or restructured
  }

  return results;
}

async function scrapeAllCounties(keywords) {
  const page = await newPage();
  const results = [];

  try {
    for (const portal of FL_COUNTY_PORTALS) {
      const portalResults = await scrapeCountyPortal(page, portal);
      results.push(...portalResults);
    }
  } finally {
    await page.close();
  }

  // Dedupe
  const seen = new Set();
  return results.filter((r) => {
    const key = `${r.agency}-${r.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function registerFLCountyTools(server) {
  server.tool(
    "fl_county_scan",
    "Scan direct FL county procurement websites for bid opportunities. Covers Polk, Hillsborough, Pinellas, Orange, Duval/Jacksonville, Volusia, Brevard, Seminole, Osceola, Pasco, Sarasota, and Manatee counties. These are direct county sites — less competition than aggregator platforms.",
    {
      keywords: z.array(z.string()).optional().describe("Custom keywords. Defaults to MPA's standard list."),
      counties: z.array(z.string()).optional().describe("Specific county names to scan. Defaults to all 12 tracked counties."),
    },
    async (params) => {
      const opps = await scrapeAllCounties(params.keywords || PORTAL_KEYWORDS);
      opps.forEach((o) => {
        const s = scoreOpportunity(o);
        o.score = s.score;
        o.relevance = s.relevance;
        o.scoreReasons = s.reasons;
      });
      opps.sort((a, b) => b.score - a.score);

      if (!opps.length) return { content: [{ type: "text", text: "No FL county procurement opportunities found." }] };

      // Group by county
      const byCounty = {};
      for (const o of opps) {
        if (!byCounty[o.agency]) byCounty[o.agency] = [];
        byCounty[o.agency].push(o);
      }

      const sections = Object.entries(byCounty).map(([county, bids]) => {
        const lines = bids.slice(0, 10).map(
          (o) => `  [${o.relevance} | Score ${o.score}] **${o.title}**${o.bidNumber ? ` (${o.bidNumber})` : ""}\n    Deadline: ${o.deadline || "N/A"} | ${o.url}`
        );
        return `### ${county} (${bids.length})\n${lines.join("\n\n")}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `## FL County Direct Procurement Scan\nFound ${opps.length} opportunities across ${Object.keys(byCounty).length} counties:\n\n${sections.join("\n\n")}`,
          },
        ],
      };
    }
  );

  server.tool(
    "fl_county_list",
    "List all FL county procurement portals being tracked, with direct URLs.",
    {},
    async () => {
      const lines = FL_COUNTY_PORTALS.map(
        (p) => `- **${p.name}** → ${p.url}`
      );
      return {
        content: [
          {
            type: "text",
            text: `## FL County Procurement Portals (${FL_COUNTY_PORTALS.length})\n\n${lines.join("\n")}`,
          },
        ],
      };
    }
  );
}

export async function runFLCountyScan(keywords) {
  const opps = await scrapeAllCounties(keywords || PORTAL_KEYWORDS);
  return opps.map((o) => {
    const s = scoreOpportunity(o);
    return { ...o, ...s };
  });
}
