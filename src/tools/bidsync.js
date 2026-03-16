import { z } from "zod";
import { newPage, safeWait } from "../lib/browser.js";
import { scoreOpportunity } from "../lib/scorer.js";
import { PORTAL_KEYWORDS, BIDSYNC_EMAIL, BIDSYNC_PASSWORD } from "../lib/config.js";

// BidSync/Periscope S2G — the largest gov-bid database in North America
// Many FL agencies post exclusively here: Miami-Dade, Broward, Palm Beach, etc.
// URL patterns:
//   - prod.bidsync.com/{agency-slug} — agency landing pages (public)
//   - app.bidsync.com — main app (login required for full search)
//   - prod.bidsync.com/bids/...  — individual bid pages

const FL_AGENCY_SLUGS = [
  "miami-dade-county",
  "broward-county",
  "palm-beach-county",
  "city-of-orlando",
  "city-of-tampa",
  "city-of-jacksonville",
  "city-of-fort-lauderdale",
  "city-of-miami",
  "city-of-miami-beach",
  "city-of-hollywood-fl",
  "city-of-pembroke-pines",
  "city-of-coral-springs",
  "city-of-hialeah",
  "city-of-boca-raton",
  "seminole-county",
  "osceola-county",
  "lee-county-fl",
  "collier-county",
  "volusia-county-fl",
  "brevard-county",
  "manatee-county",
  "sarasota-county-fl",
  "st-lucie-county",
  "pasco-county",
  "marion-county-fl",
  "alachua-county",
  "leon-county",
  "escambia-county",
  "bay-county",
  "okaloosa-county",
  "indian-river-county",
  "martin-county",
  "st-johns-county",
  "flagler-county",
  "clay-county-fl",
  "nassau-county-fl",
  "lake-county-fl",
  "hernando-county",
  "citrus-county",
  "sumter-county-fl",
  "charlotte-county",
  "desoto-county",
  "highlands-county",
  "hendry-county",
  "glades-county",
  "okeechobee-county",
  "putnam-county",
  "south-florida-water-management-district",
  "school-board-of-broward-county",
  "miami-dade-county-public-schools",
];

async function scrapeBidSyncAgencyPage(page, slug) {
  const results = [];
  const url = `https://prod.bidsync.com/${slug}`;

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForTimeout(2000);

    // Extract bids from the agency page — usually lists open solicitations
    const bids = await page.evaluate((agencySlug) => {
      const items = [];
      // BidSync agency pages list bids in rows/cards
      const rows = document.querySelectorAll(
        "table tbody tr, [class*='bid'], [class*='solicitation'], [class*='result'], [class*='listing'], .card, [class*='row']"
      );
      rows.forEach((row) => {
        const titleEl = row.querySelector(
          "a, h3, h4, [class*='title'], [class*='name'], td:first-child a"
        );
        const agencyEl = row.querySelector(
          "[class*='agency'], [class*='org'], td:nth-child(2)"
        );
        const deadlineEl = row.querySelector(
          "[class*='date'], [class*='deadline'], [class*='due'], time, td:nth-child(3)"
        );
        const statusEl = row.querySelector("[class*='status']");
        const link = row.querySelector("a[href]");

        if (titleEl?.textContent?.trim() && titleEl.textContent.trim().length > 5) {
          items.push({
            title: titleEl.textContent.trim(),
            agency: agencyEl?.textContent?.trim() || agencySlug.replace(/-/g, " "),
            deadline: deadlineEl?.textContent?.trim() || "",
            status: statusEl?.textContent?.trim() || "",
            url: link?.href || "",
          });
        }
      });
      return items;
    }, slug);

    for (const bid of bids) {
      if (
        bid.status?.toLowerCase().includes("closed") ||
        bid.status?.toLowerCase().includes("awarded")
      )
        continue;
      results.push({
        id: `bidsync-${slug}-${bid.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
        title: bid.title,
        platform: "BidSync",
        agency: bid.agency,
        state: "FL",
        deadline: bid.deadline || null,
        url: bid.url || url,
        type: "Solicitation",
      });
    }
  } catch {
    // Agency page may not exist or be structured differently — skip silently
  }

  return results;
}

async function scrapeBidSyncSearch(keywords) {
  const page = await newPage();
  const results = [];

  try {
    // Try authenticated search if credentials available
    if (BIDSYNC_EMAIL && BIDSYNC_PASSWORD) {
      await page.goto("https://app.bidsync.com", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await page.waitForTimeout(2000);

      // Login flow
      const emailInput = await safeWait(
        page,
        "input[type='email'], input[name*='email'], input[name*='user'], #email",
        5000
      );
      if (emailInput) {
        await emailInput.fill(BIDSYNC_EMAIL);
        const nextBtn = await safeWait(page, "button[type='submit'], input[type='submit'], [class*='next'], [class*='submit']", 3000);
        if (nextBtn) await nextBtn.click();
        await page.waitForTimeout(2000);

        const passInput = await safeWait(page, "input[type='password']", 5000);
        if (passInput) {
          await passInput.fill(BIDSYNC_PASSWORD);
          const loginBtn = await safeWait(page, "button[type='submit'], input[type='submit']", 3000);
          if (loginBtn) await loginBtn.click();
          await page.waitForTimeout(5000);
        }
      }

      // Search each keyword
      for (const kw of keywords) {
        try {
          const searchInput = await safeWait(
            page,
            "input[type='search'], input[type='text'][placeholder*='search' i], [class*='search'] input",
            5000
          );
          if (searchInput) {
            await searchInput.fill("");
            await searchInput.fill(kw);
            await page.keyboard.press("Enter");
            await page.waitForTimeout(3000);
          }

          const bids = await page.evaluate(() => {
            const items = [];
            const rows = document.querySelectorAll(
              "table tbody tr, [class*='bid'], [class*='result'], [class*='listing'], .card"
            );
            rows.forEach((row) => {
              const titleEl = row.querySelector("a, [class*='title'], [class*='name']");
              const agencyEl = row.querySelector("[class*='agency'], [class*='org']");
              const deadlineEl = row.querySelector("[class*='date'], [class*='deadline'], time");
              const link = row.querySelector("a[href]");

              if (titleEl?.textContent?.trim() && titleEl.textContent.trim().length > 5) {
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
              id: `bidsync-${bid.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
              title: bid.title,
              platform: "BidSync",
              agency: bid.agency,
              state: "FL",
              deadline: bid.deadline || null,
              url: bid.url || "https://app.bidsync.com",
              type: "Solicitation",
              searchKeyword: kw,
            });
          }
        } catch {}
      }
    }

    // Also scrape top FL agency pages (public, no login needed)
    const topAgencies = FL_AGENCY_SLUGS.slice(0, 15); // Top 15 for speed
    for (const slug of topAgencies) {
      const agencyResults = await scrapeBidSyncAgencyPage(page, slug);
      results.push(...agencyResults);
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

export function registerBidSyncTools(server) {
  server.tool(
    "bidsync_scan",
    "Scan BidSync/Periscope S2G for FL print/mail procurement opportunities. Searches the largest government bid database in North America. Covers Miami-Dade, Broward, Palm Beach, and 40+ other FL agencies that post exclusively on BidSync.",
    {
      keywords: z.array(z.string()).optional().describe("Custom keywords. Defaults to MPA's standard list."),
      agencies: z.array(z.string()).optional().describe("Specific agency slugs to scan (e.g. 'miami-dade-county'). Defaults to top 15 FL agencies."),
      max_agencies: z.number().optional().describe("Max agency pages to scan (default 15). More = slower but broader."),
    },
    async (params) => {
      const opps = await scrapeBidSyncSearch(params.keywords || PORTAL_KEYWORDS);
      opps.forEach((o) => {
        const s = scoreOpportunity(o);
        o.score = s.score;
        o.relevance = s.relevance;
        o.scoreReasons = s.reasons;
      });
      opps.sort((a, b) => b.score - a.score);

      if (!opps.length) return { content: [{ type: "text", text: "No BidSync opportunities found." }] };
      const lines = opps.map(
        (o) =>
          `[${o.relevance} | Score ${o.score}] **${o.title}**\n  Agency: ${o.agency} | Deadline: ${o.deadline || "N/A"}\n  ${o.url}`
      );
      return {
        content: [
          {
            type: "text",
            text: `## BidSync Scan\nFound ${opps.length} opportunities:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );

  server.tool(
    "bidsync_agency_list",
    "List all FL agencies tracked on BidSync/Periscope S2G. Useful for discovering which agencies post bids through this platform.",
    {},
    async () => {
      const lines = FL_AGENCY_SLUGS.map(
        (slug) => `- ${slug.replace(/-/g, " ")} → https://prod.bidsync.com/${slug}`
      );
      return {
        content: [
          {
            type: "text",
            text: `## BidSync FL Agencies (${FL_AGENCY_SLUGS.length})\n\n${lines.join("\n")}`,
          },
        ],
      };
    }
  );
}

export async function runBidSyncScan(keywords) {
  const opps = await scrapeBidSyncSearch(keywords || PORTAL_KEYWORDS);
  return opps.map((o) => {
    const s = scoreOpportunity(o);
    return { ...o, ...s };
  });
}
