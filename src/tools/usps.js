import { z } from "zod";
import { newPage, safeWait } from "../lib/browser.js";
import { scoreOpportunity } from "../lib/scorer.js";
import { USPS_COUPA_EMAIL, USPS_COUPA_PASSWORD } from "../lib/config.js";

// USPS eSourcing / Coupa Supplier Portal
// USPS is the largest mailer in the US — they outsource significant print/mail work
// Moved from Emptoris to Coupa Supplier Portal
// Registration: email eSourcing@usps.gov with supplier form
// Portal: https://usps.coupahost.com (Coupa Supplier Portal)
// Also check: https://about.usps.com/what/business-services/suppliers/ for open solicitations
// And: https://usps.com/suppliersdiversity/ for subcontracting opportunities

const USPS_URLS = {
  supplierPage: "https://about.usps.com/what/business-services/suppliers/",
  solicitations: "https://about.usps.com/what/business-services/suppliers/solicitations.htm",
  gateway: "https://about.usps.com/suppliers/gateway/",
  suppliersMain: "https://about.usps.com/suppliers/",
};

async function scrapeUSPSSolicitations() {
  const page = await newPage();
  const results = [];

  try {
    // Check the USPS supplier solicitations page (public)
    await page.goto(USPS_URLS.solicitations, {
      waitUntil: "networkidle",
      timeout: 25000,
    });
    await page.waitForTimeout(3000);

    // Extract solicitation listings
    const solicitations = await page.evaluate(() => {
      const items = [];
      // USPS lists solicitations in various formats — tables, lists, or content blocks
      const tables = document.querySelectorAll("table");
      tables.forEach((table) => {
        const rows = table.querySelectorAll("tbody tr, tr");
        rows.forEach((row, i) => {
          if (i === 0 && row.querySelector("th")) return;
          const cells = row.querySelectorAll("td");
          if (cells.length < 2) return;

          const titleCell = cells[1] || cells[0];
          const link = titleCell?.querySelector("a") || cells[0]?.querySelector("a");
          const title = link?.textContent?.trim() || titleCell?.textContent?.trim() || "";
          const solNum = cells[0]?.textContent?.trim() || "";
          const date = cells[cells.length - 1]?.textContent?.trim() || cells[2]?.textContent?.trim() || "";

          if (title && title.length > 5) {
            items.push({ title, solNum, date, url: link?.href || "" });
          }
        });
      });

      // Also check for links that look like solicitation postings
      if (items.length === 0) {
        const allLinks = document.querySelectorAll("a[href]");
        allLinks.forEach((a) => {
          const text = a.textContent?.trim() || "";
          const href = a.href || "";
          if (
            text.length > 10 &&
            (text.toLowerCase().includes("solicitation") ||
              text.toLowerCase().includes("rfp") ||
              text.toLowerCase().includes("rfq") ||
              text.toLowerCase().includes("bid") ||
              href.includes("solicitation") ||
              href.includes("rfp"))
          ) {
            items.push({ title: text, solNum: "", date: "", url: href });
          }
        });
      }

      // Also extract from content blocks (paragraphs, divs)
      const contentBlocks = document.querySelectorAll(
        "main p, main li, article p, article li, .field--name-body p, .field--name-body li"
      );
      contentBlocks.forEach((block) => {
        const text = block.textContent?.trim() || "";
        const link = block.querySelector("a[href]");
        // Look for solicitation-like content
        if (
          text.length > 20 &&
          (text.match(/solicitation|rfp|rfq|bid|proposal/i)) &&
          link
        ) {
          items.push({
            title: link.textContent?.trim() || text.substring(0, 200),
            solNum: "",
            date: "",
            url: link.href,
          });
        }
      });

      return items;
    });

    for (const sol of solicitations) {
      results.push({
        id: `usps-${sol.solNum || sol.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
        title: sol.title,
        platform: "USPS",
        agency: "United States Postal Service",
        state: "National",
        deadline: sol.date || null,
        url: sol.url || USPS_URLS.solicitations,
        type: "Solicitation",
        solicitationNumber: sol.solNum || "",
      });
    }

    // Also check the main suppliers page for any open opportunities
    await page.goto(USPS_URLS.supplierPage, {
      waitUntil: "networkidle",
      timeout: 20000,
    });
    await page.waitForTimeout(2000);

    const supplierPageOpps = await page.evaluate(() => {
      const items = [];
      const links = document.querySelectorAll("a[href]");
      links.forEach((a) => {
        const text = a.textContent?.trim() || "";
        const href = a.href || "";
        if (
          text.length > 10 &&
          (href.includes("solicitation") ||
            href.includes("opportunity") ||
            href.includes("bid") ||
            href.includes("rfp") ||
            href.includes("contract"))
        ) {
          items.push({
            title: text,
            url: href,
          });
        }
      });
      return items;
    });

    for (const opp of supplierPageOpps) {
      results.push({
        id: `usps-supplier-${opp.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
        title: opp.title,
        platform: "USPS",
        agency: "United States Postal Service",
        state: "National",
        url: opp.url || USPS_URLS.supplierPage,
        type: "Opportunity",
      });
    }

    // If Coupa credentials available, check the Coupa Supplier Portal
    if (USPS_COUPA_EMAIL && USPS_COUPA_PASSWORD) {
      try {
        await page.goto("https://usps.coupahost.com", {
          waitUntil: "networkidle",
          timeout: 30000,
        });
        await page.waitForTimeout(3000);

        const emailInput = await safeWait(
          page,
          "input[type='email'], input[name*='email'], input[name*='user'], #email, #user_email",
          5000
        );
        if (emailInput) {
          await emailInput.fill(USPS_COUPA_EMAIL);
          const passInput = await safeWait(page, "input[type='password']", 5000);
          if (passInput) {
            await passInput.fill(USPS_COUPA_PASSWORD);
            const loginBtn = await safeWait(page, "button[type='submit'], input[type='submit'], [class*='login']", 3000);
            if (loginBtn) await loginBtn.click();
            await page.waitForTimeout(5000);

            // Check for sourcing events / RFPs
            const coupaSourcingLink = await safeWait(
              page,
              "a[href*='sourcing'], a[href*='event'], [class*='sourcing'], [class*='rfp']",
              5000
            );
            if (coupaSourcingLink) {
              await coupaSourcingLink.click();
              await page.waitForTimeout(3000);

              const events = await page.evaluate(() => {
                const items = [];
                const rows = document.querySelectorAll(
                  "table tbody tr, [class*='event'], [class*='sourcing'], [class*='card']"
                );
                rows.forEach((row) => {
                  const titleEl = row.querySelector("a, [class*='title'], [class*='name'], td:first-child a");
                  const dateEl = row.querySelector("[class*='date'], time, td:nth-child(3)");
                  const statusEl = row.querySelector("[class*='status'], [class*='badge']");
                  const link = row.querySelector("a[href]");

                  if (titleEl?.textContent?.trim()) {
                    items.push({
                      title: titleEl.textContent.trim(),
                      deadline: dateEl?.textContent?.trim() || "",
                      status: statusEl?.textContent?.trim() || "",
                      url: link?.href || "",
                    });
                  }
                });
                return items;
              });

              for (const ev of events) {
                results.push({
                  id: `usps-coupa-${ev.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
                  title: `[Coupa] ${ev.title}`,
                  platform: "USPS",
                  agency: "USPS (via Coupa Portal)",
                  state: "National",
                  deadline: ev.deadline || null,
                  url: ev.url || "https://usps.coupahost.com",
                  type: "Sourcing Event",
                });
              }
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

export function registerUSPSTools(server) {
  server.tool(
    "usps_scan",
    "Scan USPS supplier pages and eSourcing portal for procurement opportunities. USPS is the largest mailer in the US and outsources significant print/mail work. Checks the public solicitations page and, if credentials are configured, the Coupa Supplier Portal for active sourcing events.",
    {
      include_coupa: z.boolean().optional().describe("Also check Coupa Supplier Portal (requires USPS_COUPA_EMAIL/PASSWORD). Default true if credentials set."),
    },
    async (params) => {
      const opps = await scrapeUSPSSolicitations();
      opps.forEach((o) => {
        const s = scoreOpportunity(o);
        o.score = s.score;
        o.relevance = s.relevance;
        o.scoreReasons = s.reasons;
      });
      opps.sort((a, b) => b.score - a.score);

      if (!opps.length) return { content: [{ type: "text", text: "No USPS procurement opportunities found." }] };
      const lines = opps.map(
        (o) =>
          `[${o.relevance} | Score ${o.score}] **${o.title}**\n  Agency: ${o.agency} | Deadline: ${o.deadline || "N/A"}\n  ${o.url}`
      );
      return {
        content: [
          {
            type: "text",
            text: `## USPS Procurement Scan\nFound ${opps.length} opportunities:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );
}

export async function runUSPSScan() {
  const opps = await scrapeUSPSSolicitations();
  return opps.map((o) => {
    const s = scoreOpportunity(o);
    return { ...o, ...s };
  });
}
