import { z } from "zod";
import { newPage, safeWait } from "../lib/browser.js";
import { scoreOpportunity } from "../lib/scorer.js";
import { PORTAL_KEYWORDS, MFMP_EMAIL, MFMP_PASSWORD } from "../lib/config.js";

async function scrapeMFMP(keywords) {
  const page = await newPage();
  const results = [];

  try {
    // MFMP public bid search (Angular SPA)
    await page.goto("https://vendor.myfloridamarketplace.com/search/bids", {
      waitUntil: "networkidle",
      timeout: 30000,
    });
    await page.waitForTimeout(5000); // Angular needs time to hydrate

    for (const kw of keywords) {
      try {
        // Type keyword into search
        const searchInput = await safeWait(page, "input[type='search'], input[type='text'], [class*='search'] input", 5000);
        if (searchInput) {
          await searchInput.fill("");
          await searchInput.fill(kw);
          await page.keyboard.press("Enter");
          await page.waitForTimeout(3000);
        } else {
          // Try URL-based search
          await page.goto(`https://vendor.myfloridamarketplace.com/search/bids?searchTerm=${encodeURIComponent(kw)}`, {
            waitUntil: "networkidle",
            timeout: 15000,
          });
          await page.waitForTimeout(3000);
        }

        // Extract results
        const bids = await page.evaluate(() => {
          const items = [];
          const rows = document.querySelectorAll("table tr, [class*='result'], [class*='bid-item'], [class*='card'], [class*='list-item']");
          rows.forEach((row) => {
            const titleEl = row.querySelector("a, [class*='title'], [class*='name'], td:first-child");
            const agencyEl = row.querySelector("[class*='agency'], [class*='org'], td:nth-child(2)");
            const statusEl = row.querySelector("[class*='status'], td:nth-child(3)");
            const dateEl = row.querySelector("[class*='date'], [class*='deadline'], td:nth-child(4), time");
            const link = row.querySelector("a[href]");

            if (titleEl?.textContent?.trim() && titleEl.textContent.trim().length > 5) {
              items.push({
                title: titleEl.textContent.trim(),
                agency: agencyEl?.textContent?.trim() || "",
                status: statusEl?.textContent?.trim() || "",
                deadline: dateEl?.textContent?.trim() || "",
                url: link?.href || "",
              });
            }
          });
          return items;
        });

        for (const bid of bids) {
          if (bid.status?.toLowerCase().includes("closed") || bid.status?.toLowerCase().includes("awarded")) continue;
          results.push({
            id: `mfmp-${bid.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
            title: bid.title,
            platform: "MFMP",
            agency: bid.agency,
            state: "FL",
            status: bid.status || "open",
            deadline: bid.deadline || null,
            url: bid.url || "https://vendor.myfloridamarketplace.com",
            type: "Solicitation",
            searchKeyword: kw,
          });
        }
      } catch {}
    }

    // Also check vendor dashboard if credentials available
    if (MFMP_EMAIL && MFMP_PASSWORD) {
      try {
        await page.goto("https://vendor.myfloridamarketplace.com/", { waitUntil: "networkidle", timeout: 20000 });
        const loginBtn = await safeWait(page, "a[href*='login'], button[class*='login'], [class*='sign-in']", 5000);
        if (loginBtn) {
          await loginBtn.click();
          await page.waitForTimeout(2000);
          const emailInput = await safeWait(page, "input[type='email'], input[name*='email'], input[name*='user']", 5000);
          const passInput = await safeWait(page, "input[type='password']", 5000);
          if (emailInput && passInput) {
            await emailInput.fill(MFMP_EMAIL);
            await passInput.fill(MFMP_PASSWORD);
            await page.keyboard.press("Enter");
            await page.waitForTimeout(5000);
            // Check dashboard for matched opportunities
            const dashboard = await page.evaluate(() => document.body.innerText.substring(0, 5000));
            // Parse any CBI or matched opportunities from dashboard text
          }
        }
      } catch {}
    }
  } finally {
    await page.close();
  }

  const seen = new Set();
  return results.filter((r) => {
    const key = r.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function registerMFMPTools(server) {
  server.tool(
    "mfmp_scan",
    "Scan MyFloridaMarketPlace (MFMP) for Florida state print/mail solicitations. Uses browser automation for the Angular SPA.",
    {
      keywords: z.array(z.string()).optional().describe("Custom keywords. Defaults to MPA's standard list."),
    },
    async (params) => {
      const opps = await scrapeMFMP(params.keywords || PORTAL_KEYWORDS);
      opps.forEach((o) => { const s = scoreOpportunity(o); o.score = s.score; o.relevance = s.relevance; });
      opps.sort((a, b) => b.score - a.score);
      if (!opps.length) return { content: [{ type: "text", text: "No MFMP opportunities found." }] };
      const lines = opps.map((o) => `[${o.relevance} | Score ${o.score}] **${o.title}**\n  Agency: ${o.agency} | Deadline: ${o.deadline || "N/A"}\n  ${o.url}`);
      return { content: [{ type: "text", text: `## MFMP Scan\nFound ${opps.length} opportunities:\n\n${lines.join("\n\n")}` }] };
    }
  );
}

export async function runMFMPScan(keywords) {
  const opps = await scrapeMFMP(keywords || PORTAL_KEYWORDS);
  return opps.map((o) => { const s = scoreOpportunity(o); return { ...o, ...s }; });
}
