import { z } from "zod";
import { newPage, safeWait } from "../lib/browser.js";
import { scoreOpportunity } from "../lib/scorer.js";
import { PORTAL_KEYWORDS, BONFIRE_EMAIL, BONFIRE_PASSWORD } from "../lib/config.js";

async function scrapeBonfire(keywords) {
  const page = await newPage();
  const results = [];

  try {
    // Login to Bonfire if credentials available
    if (BONFIRE_EMAIL && BONFIRE_PASSWORD) {
      await page.goto("https://bonfirehub.com/login", { waitUntil: "networkidle", timeout: 20000 });
      const emailInput = await safeWait(page, "input[type='email'], input[name*='email']", 5000);
      const passInput = await safeWait(page, "input[type='password']", 5000);
      if (emailInput && passInput) {
        await emailInput.fill(BONFIRE_EMAIL);
        await passInput.fill(BONFIRE_PASSWORD);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(5000);
      }

      // Check vendor dashboard for followed/invited opportunities
      try {
        await page.goto("https://bonfirehub.com/portal/opportunities", { waitUntil: "networkidle", timeout: 15000 });
        await page.waitForTimeout(3000);
        const dashboardOpps = await page.evaluate(() => {
          const items = [];
          document.querySelectorAll("[class*='opportunity'], [class*='card'], tr, [class*='list-item']").forEach((el) => {
            const title = el.querySelector("a, [class*='title'], [class*='name']")?.textContent?.trim();
            const org = el.querySelector("[class*='org'], [class*='agency'], [class*='buyer']")?.textContent?.trim();
            const deadline = el.querySelector("[class*='date'], [class*='deadline'], time")?.textContent?.trim();
            const link = el.querySelector("a[href*='opportunity'], a[href*='portal']")?.href;
            const status = el.querySelector("[class*='status'], [class*='badge']")?.textContent?.trim();
            if (title && title.length > 5) items.push({ title, agency: org || "", deadline: deadline || "", url: link || "", status: status || "" });
          });
          return items;
        });
        for (const bid of dashboardOpps) {
          if (bid.status?.toLowerCase().includes("closed") || bid.status?.toLowerCase().includes("awarded")) continue;
          results.push({
            id: `bonfire-${bid.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
            title: bid.title, platform: "Bonfire", agency: bid.agency, deadline: bid.deadline || null,
            url: bid.url || "https://bonfirehub.com", type: "Solicitation", source: "dashboard",
          });
        }
      } catch {}
    }

    // Public search
    for (const kw of keywords) {
      try {
        await page.goto(`https://bonfirehub.com/opportunities?search=${encodeURIComponent(kw)}&status=open`, {
          waitUntil: "networkidle", timeout: 15000,
        });
        await page.waitForTimeout(3000);
        const bids = await page.evaluate(() => {
          const items = [];
          document.querySelectorAll("[class*='opportunity'], [class*='card'], [class*='result'], tr").forEach((el) => {
            const title = el.querySelector("a, [class*='title']")?.textContent?.trim();
            const org = el.querySelector("[class*='org'], [class*='buyer']")?.textContent?.trim();
            const deadline = el.querySelector("[class*='date'], time")?.textContent?.trim();
            const link = el.querySelector("a[href]")?.href;
            if (title && title.length > 5) items.push({ title, agency: org || "", deadline: deadline || "", url: link || "" });
          });
          return items;
        });
        for (const bid of bids) {
          results.push({
            id: `bonfire-${bid.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
            title: bid.title, platform: "Bonfire", agency: bid.agency, deadline: bid.deadline || null,
            url: bid.url || "https://bonfirehub.com", type: "Solicitation", searchKeyword: kw,
          });
        }
      } catch {}
    }
  } finally {
    await page.close();
  }

  const seen = new Set();
  return results.filter((r) => { const key = r.title.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}

export function registerBonfireTools(server) {
  server.tool(
    "bonfire_scan",
    "Scan Bonfire/Euna procurement portal for print/mail opportunities. Checks vendor dashboard and public search.",
    { keywords: z.array(z.string()).optional() },
    async (params) => {
      const opps = await scrapeBonfire(params.keywords || PORTAL_KEYWORDS);
      opps.forEach((o) => { const s = scoreOpportunity(o); o.score = s.score; o.relevance = s.relevance; });
      opps.sort((a, b) => b.score - a.score);
      if (!opps.length) return { content: [{ type: "text", text: "No Bonfire opportunities found." }] };
      const lines = opps.map((o) => `[${o.relevance} | Score ${o.score}] **${o.title}**\n  Agency: ${o.agency} | Deadline: ${o.deadline || "N/A"}\n  Source: ${o.source || "search"} | ${o.url}`);
      return { content: [{ type: "text", text: `## Bonfire Scan\nFound ${opps.length} opportunities:\n\n${lines.join("\n\n")}` }] };
    }
  );
}

export async function runBonfireScan(keywords) {
  const opps = await scrapeBonfire(keywords || PORTAL_KEYWORDS);
  return opps.map((o) => { const s = scoreOpportunity(o); return { ...o, ...s }; });
}
