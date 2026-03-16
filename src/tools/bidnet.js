import { z } from "zod";
import { newPage, safeWait } from "../lib/browser.js";
import { scoreOpportunity } from "../lib/scorer.js";
import { PORTAL_KEYWORDS, BIDNET_EMAIL, BIDNET_PASSWORD } from "../lib/config.js";

async function scrapeBidNet(keywords) {
  const page = await newPage();
  const results = [];

  try {
    // Login to BidNet
    if (BIDNET_EMAIL && BIDNET_PASSWORD) {
      await page.goto("https://www.bidnetdirect.com/login", { waitUntil: "networkidle", timeout: 20000 });
      await page.waitForTimeout(2000);
      const emailInput = await safeWait(page, "input[type='email'], input[name*='email'], input[name*='Email'], #Email", 5000);
      const passInput = await safeWait(page, "input[type='password'], input[name*='password'], input[name*='Password'], #Password", 5000);
      if (emailInput && passInput) {
        await emailInput.fill(BIDNET_EMAIL);
        await passInput.fill(BIDNET_PASSWORD);
        const submitBtn = await safeWait(page, "button[type='submit'], input[type='submit'], [class*='login-btn']", 3000);
        if (submitBtn) await submitBtn.click();
        else await page.keyboard.press("Enter");
        await page.waitForTimeout(5000);
      }

      // Check org matching profile
      try {
        await page.goto("https://www.bidnetdirect.com/private/supplier/solicitations/search", {
          waitUntil: "networkidle", timeout: 15000,
        });
        await page.waitForTimeout(3000);
        const matchedOpps = await page.evaluate(() => {
          const items = [];
          document.querySelectorAll("tr, [class*='solicitation'], [class*='result'], [class*='card']").forEach((el) => {
            const title = el.querySelector("a, [class*='title'], [class*='name'], td:first-child a")?.textContent?.trim();
            const agency = el.querySelector("[class*='agency'], [class*='org'], td:nth-child(2)")?.textContent?.trim();
            const deadline = el.querySelector("[class*='date'], [class*='deadline'], td:nth-child(3), time")?.textContent?.trim();
            const status = el.querySelector("[class*='status'], [class*='badge']")?.textContent?.trim();
            const link = el.querySelector("a[href*='solicitation'], a[href*='bid']")?.href;
            if (title && title.length > 5) items.push({ title, agency: agency || "", deadline: deadline || "", status: status || "", url: link || "" });
          });
          return items;
        });
        for (const bid of matchedOpps) {
          if (bid.status?.toLowerCase().includes("closed") || bid.status?.toLowerCase().includes("completed")) continue;
          results.push({
            id: `bidnet-${bid.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
            title: bid.title, platform: "BidNet", agency: bid.agency, state: "FL", deadline: bid.deadline || null,
            url: bid.url || "https://www.bidnetdirect.com", type: "Solicitation", source: "org-match",
          });
        }
      } catch {}
    }

    // Keyword searches
    for (const kw of keywords) {
      try {
        const searchUrl = BIDNET_EMAIL
          ? `https://www.bidnetdirect.com/private/supplier/solicitations/search?keywords=${encodeURIComponent(kw)}&state=FL`
          : `https://www.bidnetdirect.com/solicitations/search?keywords=${encodeURIComponent(kw)}&state=FL`;
        await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 15000 });
        await page.waitForTimeout(3000);
        const bids = await page.evaluate(() => {
          const items = [];
          document.querySelectorAll("tr, [class*='solicitation'], [class*='result']").forEach((el) => {
            const title = el.querySelector("a, [class*='title']")?.textContent?.trim();
            const agency = el.querySelector("[class*='agency'], [class*='org'], td:nth-child(2)")?.textContent?.trim();
            const deadline = el.querySelector("[class*='date'], time")?.textContent?.trim();
            const link = el.querySelector("a[href]")?.href;
            if (title && title.length > 5) items.push({ title, agency: agency || "", deadline: deadline || "", url: link || "" });
          });
          return items;
        });
        for (const bid of bids) {
          results.push({
            id: `bidnet-${bid.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
            title: bid.title, platform: "BidNet", agency: bid.agency, state: "FL", deadline: bid.deadline || null,
            url: bid.url || "https://www.bidnetdirect.com", type: "Solicitation", searchKeyword: kw,
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

export function registerBidNetTools(server) {
  server.tool(
    "bidnet_scan",
    "Scan BidNet Direct for Florida print/mail bid opportunities. Logs in to check org matching profile and runs keyword searches.",
    { keywords: z.array(z.string()).optional() },
    async (params) => {
      const opps = await scrapeBidNet(params.keywords || PORTAL_KEYWORDS);
      opps.forEach((o) => { const s = scoreOpportunity(o); o.score = s.score; o.relevance = s.relevance; });
      opps.sort((a, b) => b.score - a.score);
      if (!opps.length) return { content: [{ type: "text", text: "No BidNet opportunities found." }] };
      const lines = opps.map((o) => `[${o.relevance} | Score ${o.score}] **${o.title}**\n  Agency: ${o.agency} | Deadline: ${o.deadline || "N/A"}\n  Source: ${o.source || "search"} | ${o.url}`);
      return { content: [{ type: "text", text: `## BidNet Scan\nFound ${opps.length} opportunities:\n\n${lines.join("\n\n")}` }] };
    }
  );
}

export async function runBidNetScan(keywords) {
  const opps = await scrapeBidNet(keywords || PORTAL_KEYWORDS);
  return opps.map((o) => { const s = scoreOpportunity(o); return { ...o, ...s }; });
}
