import { z } from "zod";
import { newPage, safeWait } from "../lib/browser.js";
import { scoreOpportunity } from "../lib/scorer.js";
import { PORTAL_KEYWORDS, MFMP_EMAIL, MFMP_PASSWORD } from "../lib/config.js";

// Florida Vendor Bid System (VBS)
// This is the state-level bid notification system at vendor.myfloridamarketplace.com
// It's part of the MFMP ecosystem but operates as a separate bid search portal
// Covers ALL Florida state agency solicitations — broader than the MFMP tool
// VBS has: advertisement search, agency filter, category filter, and date range filter
// URL: https://vendor.myfloridamarketplace.com/search/bids/results
//
// Note: The existing mfmp_scan tool searches the general MFMP bid search.
// This tool specifically targets the VBS advertisement search with more filters
// and the vendor dashboard for matched opportunities.

async function scrapeVBS(keywords) {
  const page = await newPage();
  const results = [];

  try {
    // VBS bid advertisement search
    for (const kw of keywords) {
      try {
        // Use the direct results URL with search parameters
        const searchUrl = `https://vendor.myfloridamarketplace.com/search/bids/results?searchTerm=${encodeURIComponent(kw)}&status=Open`;
        await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 25000 });
        await page.waitForTimeout(4000); // Angular SPA needs hydration time

        // Also try alternate search approaches
        const searchInput = await safeWait(
          page,
          "input[type='search'], input[type='text'][placeholder*='search' i], [class*='search'] input, input[formcontrolname], input[name*='search' i]",
          5000
        );
        if (searchInput) {
          await searchInput.fill("");
          await searchInput.fill(kw);
          await page.keyboard.press("Enter");
          await page.waitForTimeout(3000);
        }

        // Extract bid results
        const bids = await page.evaluate(() => {
          const items = [];
          // VBS results display as cards or table rows
          const rows = document.querySelectorAll(
            "[class*='result'], [class*='bid'], [class*='card'], [class*='solicitation'], table tbody tr, [class*='list-item'], [class*='mat-card'], [class*='mat-row'], [class*='advertisement']"
          );

          rows.forEach((row) => {
            const titleEl = row.querySelector(
              "a, [class*='title'], [class*='name'], h3, h4, td:first-child a, [class*='mat-line']"
            );
            const agencyEl = row.querySelector(
              "[class*='agency'], [class*='org'], [class*='buyer'], td:nth-child(2), [class*='mat-line']:nth-child(2)"
            );
            const statusEl = row.querySelector(
              "[class*='status'], [class*='badge'], [class*='chip']"
            );
            const dateEl = row.querySelector(
              "[class*='date'], [class*='deadline'], [class*='due'], time, td:nth-child(3)"
            );
            const categoryEl = row.querySelector(
              "[class*='category'], [class*='type'], [class*='code']"
            );
            const link = row.querySelector("a[href]");

            if (titleEl?.textContent?.trim() && titleEl.textContent.trim().length > 5) {
              items.push({
                title: titleEl.textContent.trim(),
                agency: agencyEl?.textContent?.trim() || "",
                status: statusEl?.textContent?.trim() || "",
                deadline: dateEl?.textContent?.trim() || "",
                category: categoryEl?.textContent?.trim() || "",
                url: link?.href || "",
              });
            }
          });
          return items;
        });

        for (const bid of bids) {
          const status = (bid.status || "").toLowerCase();
          if (status.includes("closed") || status.includes("awarded") || status.includes("cancelled")) continue;

          results.push({
            id: `fl-vbs-${bid.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
            title: bid.title,
            platform: "FL VBS",
            agency: bid.agency,
            state: "FL",
            status: bid.status || "open",
            deadline: bid.deadline || null,
            category: bid.category || "",
            url: bid.url || "https://vendor.myfloridamarketplace.com/search/bids",
            type: "Solicitation",
            searchKeyword: kw,
          });
        }
      } catch {}
    }

    // If credentials available, also check the vendor dashboard for matched CBI opportunities
    if (MFMP_EMAIL && MFMP_PASSWORD) {
      try {
        await page.goto("https://vendor.myfloridamarketplace.com/", {
          waitUntil: "networkidle",
          timeout: 20000,
        });

        // Look for login link
        const loginLink = await safeWait(
          page,
          "a[href*='login'], button[class*='login'], [class*='sign-in'], a:has-text('Log In'), a:has-text('Sign In')",
          5000
        );
        if (loginLink) {
          await loginLink.click();
          await page.waitForTimeout(3000);

          const emailInput = await safeWait(page, "input[type='email'], input[name*='email'], input[name*='user'], #username", 5000);
          const passInput = await safeWait(page, "input[type='password']", 5000);

          if (emailInput && passInput) {
            await emailInput.fill(MFMP_EMAIL);
            await passInput.fill(MFMP_PASSWORD);
            await page.keyboard.press("Enter");
            await page.waitForTimeout(5000);

            // Navigate to matched opportunities / CBI dashboard
            const dashboardItems = await page.evaluate(() => {
              const items = [];
              // Look for matched solicitations, CBI results, or recommended bids
              const sections = document.querySelectorAll(
                "[class*='match'], [class*='recommend'], [class*='alert'], [class*='notification'], [class*='dashboard'] [class*='item'], [class*='opportunity']"
              );
              sections.forEach((section) => {
                const titleEl = section.querySelector("a, [class*='title'], h3, h4");
                const dateEl = section.querySelector("[class*='date'], time");
                const link = section.querySelector("a[href]");
                if (titleEl?.textContent?.trim()) {
                  items.push({
                    title: titleEl.textContent.trim(),
                    deadline: dateEl?.textContent?.trim() || "",
                    url: link?.href || "",
                    source: "VBS Dashboard Match",
                  });
                }
              });
              return items;
            });

            for (const item of dashboardItems) {
              results.push({
                id: `fl-vbs-dash-${item.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
                title: `[Dashboard Match] ${item.title}`,
                platform: "FL VBS",
                agency: "Matched via MFMP Profile",
                state: "FL",
                deadline: item.deadline || null,
                url: item.url || "https://vendor.myfloridamarketplace.com",
                type: "CBI Match",
              });
            }
          }
        }
      } catch {}
    }
  } finally {
    await page.close();
  }

  // Dedupe
  const seen = new Set();
  return results.filter((r) => {
    const key = r.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function registerFLVBSTools(server) {
  server.tool(
    "fl_vbs_scan",
    "Scan the Florida Vendor Bid System (VBS) for state-level procurement opportunities. Covers ALL Florida state agency solicitations. Complements the MFMP tool by searching VBS advertisement listings with category filters. If MFMP credentials are configured, also checks the vendor dashboard for matched CBI opportunities.",
    {
      keywords: z.array(z.string()).optional().describe("Custom keywords. Defaults to MPA's standard list."),
    },
    async (params) => {
      const opps = await scrapeVBS(params.keywords || PORTAL_KEYWORDS);
      opps.forEach((o) => {
        const s = scoreOpportunity(o);
        o.score = s.score;
        o.relevance = s.relevance;
        o.scoreReasons = s.reasons;
      });
      opps.sort((a, b) => b.score - a.score);

      if (!opps.length) return { content: [{ type: "text", text: "No FL VBS opportunities found." }] };
      const lines = opps.map(
        (o) =>
          `[${o.relevance} | Score ${o.score}] **${o.title}**\n  Agency: ${o.agency} | Deadline: ${o.deadline || "N/A"}\n  Category: ${o.category || "N/A"}\n  ${o.url}`
      );
      return {
        content: [
          {
            type: "text",
            text: `## Florida VBS Scan\nFound ${opps.length} opportunities:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );
}

export async function runFLVBSScan(keywords) {
  const opps = await scrapeVBS(keywords || PORTAL_KEYWORDS);
  return opps.map((o) => {
    const s = scoreOpportunity(o);
    return { ...o, ...s };
  });
}
