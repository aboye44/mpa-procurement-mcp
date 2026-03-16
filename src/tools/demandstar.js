import { z } from "zod";
import { newPage, safeWait, closeBrowser } from "../lib/browser.js";
import { scoreOpportunity } from "../lib/scorer.js";
import { PORTAL_KEYWORDS } from "../lib/config.js";

async function scrapeDemandStar(keywords) {
  const page = await newPage();
  const results = [];

  try {
    // DemandStar Florida agencies page
    await page.goto("https://www.demandstar.com/app/agencies/Florida", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    for (const kw of keywords) {
      try {
        // Try the search functionality
        await page.goto(`https://www.demandstar.com/app/bids?search=${encodeURIComponent(kw)}&state=FL&status=open`, {
          waitUntil: "networkidle",
          timeout: 20000,
        });
        await page.waitForTimeout(2000);

        // Extract bid listings
        const bids = await page.evaluate(() => {
          const items = [];
          // Try multiple selectors for bid cards/rows
          const cards = document.querySelectorAll("[class*='bid'], [class*='result'], [class*='listing'], tr[class*='row'], .card");
          cards.forEach((card) => {
            const titleEl = card.querySelector("a, h3, h4, [class*='title'], [class*='name']");
            const agencyEl = card.querySelector("[class*='agency'], [class*='org'], [class*='buyer']");
            const deadlineEl = card.querySelector("[class*='date'], [class*='deadline'], [class*='due'], time");
            const link = card.querySelector("a[href*='bid'], a[href*='solicitation']");

            if (titleEl?.textContent?.trim()) {
              items.push({
                title: titleEl.textContent.trim(),
                agency: agencyEl?.textContent?.trim() || "",
                deadline: deadlineEl?.textContent?.trim() || "",
                url: link?.href || "",
              });
            }
          });
          return items;
        });

        for (const bid of bids) {
          results.push({
            id: `demandstar-${bid.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
            title: bid.title,
            platform: "DemandStar",
            agency: bid.agency,
            state: "FL",
            deadline: bid.deadline || null,
            url: bid.url || "https://www.demandstar.com",
            type: "Solicitation",
            searchKeyword: kw,
          });
        }
      } catch (err) {
        // Continue with next keyword
      }
    }
  } finally {
    await page.close();
  }

  // Dedupe by title
  const seen = new Set();
  return results.filter((r) => {
    const key = r.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function registerDemandStarTools(server) {
  server.tool(
    "demandstar_scan",
    "Scan DemandStar for Florida print/mail/courier procurement opportunities. Uses browser automation to search the dynamic web app.",
    {
      keywords: z.array(z.string()).optional().describe("Custom keywords to search. Defaults to MPA's standard list."),
    },
    async (params) => {
      const keywords = params.keywords || PORTAL_KEYWORDS;
      const opps = await scrapeDemandStar(keywords);
      opps.forEach((o) => { const s = scoreOpportunity(o); o.score = s.score; o.relevance = s.relevance; o.scoreReasons = s.reasons; });
      opps.sort((a, b) => b.score - a.score);

      if (!opps.length) return { content: [{ type: "text", text: "No DemandStar opportunities found." }] };
      const lines = opps.map((o) => `[${o.relevance} | Score ${o.score}] **${o.title}**\n  Agency: ${o.agency} | Deadline: ${o.deadline || "N/A"}\n  ${o.url}`);
      return { content: [{ type: "text", text: `## DemandStar Scan\nFound ${opps.length} opportunities:\n\n${lines.join("\n\n")}` }] };
    }
  );
}

export async function runDemandStarScan(keywords) {
  const opps = await scrapeDemandStar(keywords || PORTAL_KEYWORDS);
  return opps.map((o) => { const s = scoreOpportunity(o); return { ...o, ...s }; });
}
