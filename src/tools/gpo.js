import { z } from "zod";
import { scoreOpportunity } from "../lib/scorer.js";
import { GPO_EMAIL, GPO_PASSWORD, PORTAL_KEYWORDS } from "../lib/config.js";

const PUBLISH_BASE = "https://publish.gpo.gov";
const GPO_GOV_BASE = "https://www.gpo.gov";

// ---- GPO product types that match MPA capabilities ----
const MPA_PRODUCT_TYPES = new Set([
  "booklets", "books", "brochures", "business cards", "cards",
  "certificates", "copies", "envelopes", "flyers", "folders",
  "forms", "labels/stickers", "leaflets", "letterheads", "magazines",
  "manuals", "newsletters", "pamphlets", "pads", "postcards",
  "posters", "programs", "reports", "stationery",
]);

// Keywords that signal MPA-relevant work in titles
const RELEVANCE_KEYWORDS = [
  "print", "mail", "envelope", "form", "booklet", "brochure",
  "newsletter", "postcard", "letterhead", "statement", "notice",
  "flyer", "pamphlet", "insert", "card", "label", "sticker",
  "copy", "copies", "document", "fulfillment", "presort",
  "direct mail", "mailing", "eddm",
];

function scoreGPOJob(job) {
  const title = (job.title || "").toLowerCase();
  const productType = (job.productType || "").toLowerCase();
  let score = 0;
  const reasons = [];

  // Product type match
  if (MPA_PRODUCT_TYPES.has(productType)) {
    score += 30;
    reasons.push(`Product type match: ${productType}`);
  }

  // Keyword matches in title
  for (const kw of RELEVANCE_KEYWORDS) {
    if (title.includes(kw)) {
      score += 15;
      reasons.push(`Keyword: "${kw}"`);
      break; // Only count first keyword match for score
    }
  }

  // Quantity scoring (MPA sweet spot: 500–500,000)
  const qty = parseInt(job.totalQuantity?.replace(/,/g, ""), 10) || 0;
  if (qty >= 500 && qty <= 500000) {
    score += 20;
    reasons.push(`Quantity in sweet spot: ${qty.toLocaleString()}`);
  } else if (qty > 500000) {
    score += 10;
    reasons.push(`High quantity: ${qty.toLocaleString()}`);
  } else if (qty > 0) {
    score += 5;
    reasons.push(`Low quantity: ${qty.toLocaleString()}`);
  }

  // Active/open scoring
  const dueDate = new Date(job.quoteDueDate);
  const now = new Date();
  if (dueDate > now) {
    const daysLeft = Math.ceil((dueDate - now) / 86400000);
    if (daysLeft <= 3) {
      score += 5;
      reasons.push(`Urgent: ${daysLeft} days left`);
    } else {
      score += 10;
      reasons.push(`${daysLeft} days until deadline`);
    }
  }

  const relevance = score >= 50 ? "HIGH" : score >= 25 ? "MEDIUM" : "LOW";
  return { score, relevance, reasons };
}

function normalizeSmallPurchase(job) {
  return {
    id: `gpo-sp-${job.jacketNumber}`,
    platform: "GPO Publish",
    type: "Small Purchase",
    title: job.title || "",
    jacketNumber: job.jacketNumber,
    productType: job.productType || "",
    agency: job.officeName || "",
    quantity: job.totalQuantity || "",
    deadline: job.quoteDueDate || null,
    postedDate: job.datePosted || null,
    shipDate: job.shipDeliveryDate || null,
    revision: (job.fRevised || "").trim(),
    hasAttachments: (job.attachmentFileNames || []).length > 0,
    attachments: job.attachmentFileNames || [],
    url: `${PUBLISH_BASE}/smallPurchase?activeTab=Opportunities`,
    quoteUrl: `${PUBLISH_BASE}/vendor/vendorQuote/${job.jacketNumber}`,
  };
}

export function registerGPOTools(server) {
  // ---- GPO Small Purchase Opportunities (public API, no auth) ----
  server.tool(
    "gpo_small_purchases",
    "Fetch all open GPO small purchase opportunities (≤$100K). Uses the public GPO Publish API — no login required. Returns scored results relevant to MPA's print/mail capabilities.",
    {
      keyword: z.string().optional().describe("Filter results by keyword in title"),
      product_type: z.string().optional().describe("Filter by product type (e.g. 'Envelopes', 'Forms', 'Booklets')"),
      min_score: z.number().optional().describe("Minimum relevance score to include (default 0)"),
    },
    async (params) => {
      const res = await fetch(`${PUBLISH_BASE}/api/ContractorConnection/GetOpenJobs`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`GPO API ${res.status}: ${await res.text().catch(() => "")}`);
      const jobs = await res.json();

      let results = jobs.map(normalizeSmallPurchase);

      // Apply keyword filter
      if (params.keyword) {
        const kw = params.keyword.toLowerCase();
        results = results.filter(
          (r) =>
            r.title.toLowerCase().includes(kw) ||
            r.productType.toLowerCase().includes(kw)
        );
      }

      // Apply product type filter
      if (params.product_type) {
        const pt = params.product_type.toLowerCase();
        results = results.filter((r) => r.productType.toLowerCase().includes(pt));
      }

      // Score all results
      results.forEach((r) => {
        const s = scoreGPOJob(r);
        r.score = s.score;
        r.relevance = s.relevance;
        r.scoreReasons = s.reasons;
      });

      // Apply min score filter
      const minScore = params.min_score || 0;
      results = results.filter((r) => r.score >= minScore);

      // Sort by score descending
      results.sort((a, b) => b.score - a.score);

      if (!results.length) {
        return {
          content: [
            {
              type: "text",
              text: `No GPO small purchase opportunities found${params.keyword ? ` matching "${params.keyword}"` : ""}.`,
            },
          ],
        };
      }

      const lines = results.map(
        (r) =>
          `[${r.relevance} | Score ${r.score}] **${r.title}**\n` +
          `  Jacket: ${r.jacketNumber}${r.revision ? ` (${r.revision})` : ""} | Product: ${r.productType}\n` +
          `  Team: ${r.agency} | Qty: ${r.quantity}\n` +
          `  Quote Due: ${r.deadline ? new Date(r.deadline).toLocaleString() : "N/A"}\n` +
          `  Ship Date: ${r.shipDate ? new Date(r.shipDate).toLocaleDateString() : "N/A"}\n` +
          `  Attachments: ${r.hasAttachments ? "Yes" : "No"}\n` +
          `  Quote URL: ${r.quoteUrl}\n` +
          `  Scoring: ${r.scoreReasons.join(", ")}`
      );

      return {
        content: [
          {
            type: "text",
            text: `## GPO Small Purchase Opportunities\nTotal open: ${jobs.length} | Showing: ${results.length}\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );

  // ---- GPO Term Contract & One-Time Bid Opportunities (browser scrape) ----
  server.tool(
    "gpo_term_bids",
    "Fetch GPO term contract and one-time bid opportunities from gpo.gov. These are larger procurements (>$100K) posted as static listings. Requires browser automation to parse the page.",
    {},
    async () => {
      // Use browser to scrape the static gpo.gov page
      const { getBrowser } = await import("../lib/browser.js");
      const browser = await getBrowser();
      const page = await browser.newPage();

      try {
        await page.goto(
          `${GPO_GOV_BASE}/how-to-work-with-us/vendors/contract-opportunities`,
          { waitUntil: "domcontentloaded", timeout: 30000 }
        );

        // Extract opportunity listings from the page
        const opportunities = await page.evaluate(() => {
          const items = [];
          // GPO lists opportunities in content blocks — look for headings + text
          const content = document.querySelector(".field--name-body, .node__content, main, article");
          if (!content) return items;

          const text = content.innerText;
          // Split by common patterns — jacket numbers, program numbers
          const blocks = text.split(/(?=Program\s*(?:No\.|Number|#)?:?\s*\d|Jacket\s*(?:No\.|Number|#)?:?\s*\d)/gi);

          for (const block of blocks) {
            if (block.trim().length < 20) continue;

            const jacketMatch = block.match(/(?:Program|Jacket)\s*(?:No\.|Number|#)?:?\s*([\d\-A-Z]+)/i);
            const titleMatch = block.match(/(?:Title|Description):?\s*(.+?)(?:\n|Bid|Due|Date|Quantity|$)/i);
            const dateMatch = block.match(/(?:Bid\s*Opening|Due\s*Date|Closing\s*Date):?\s*(.+?)(?:\n|$)/i);
            const typeMatch = block.match(/(Term\s*Contract|One[- ]Time\s*Bid)/i);
            const teamMatch = block.match(/((?:North|South|East|West|Central)\w*\s*Team)/i);

            if (jacketMatch || titleMatch) {
              items.push({
                jacketNumber: jacketMatch ? jacketMatch[1].trim() : "",
                title: titleMatch ? titleMatch[1].trim() : block.substring(0, 200).trim(),
                bidDate: dateMatch ? dateMatch[1].trim() : "",
                contractType: typeMatch ? typeMatch[1].trim() : "Unknown",
                team: teamMatch ? teamMatch[1].trim() : "",
                rawText: block.substring(0, 500).trim(),
              });
            }
          }
          return items;
        });

        await page.close();

        if (!opportunities.length) {
          return {
            content: [
              {
                type: "text",
                text: "No term contract or one-time bid opportunities found on GPO.gov (page may have changed format).",
              },
            ],
          };
        }

        const lines = opportunities.map(
          (o) =>
            `**${o.title || o.rawText.substring(0, 100)}**\n` +
            `  Jacket/Program: ${o.jacketNumber || "N/A"} | Type: ${o.contractType}\n` +
            `  Bid Opening: ${o.bidDate || "N/A"} | Team: ${o.team || "N/A"}\n` +
            `  URL: ${GPO_GOV_BASE}/how-to-work-with-us/vendors/contract-opportunities`
        );

        return {
          content: [
            {
              type: "text",
              text: `## GPO Term Contract & One-Time Bid Opportunities\nFound: ${opportunities.length}\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (err) {
        await page.close().catch(() => {});
        throw new Error(`GPO term bids scrape failed: ${err.message}`);
      }
    }
  );

  // ---- GPO Combined MPA Scan ----
  server.tool(
    "gpo_mpa_scan",
    "Run MPA-optimized GPO scan: fetches all small purchases via API, scrapes term/one-time bids, scores everything for MPA relevance. Returns combined results sorted by score.",
    {
      include_term_bids: z.boolean().optional().describe("Also scrape term contracts/one-time bids (slower, uses browser). Default true."),
    },
    async (params) => {
      const includeTerm = params.include_term_bids !== false;
      const allResults = [];
      const errors = [];

      // Small purchases via API
      try {
        const res = await fetch(`${PUBLISH_BASE}/api/ContractorConnection/GetOpenJobs`, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`API ${res.status}`);
        const jobs = await res.json();
        const scored = jobs.map((j) => {
          const norm = normalizeSmallPurchase(j);
          const s = scoreGPOJob(norm);
          return { ...norm, ...s, platform: "GPO Publish" };
        });
        allResults.push(...scored);
      } catch (e) {
        errors.push(`Small Purchases: ${e.message}`);
      }

      // Term contracts via browser
      if (includeTerm) {
        try {
          const { getBrowser } = await import("../lib/browser.js");
          const browser = await getBrowser();
          const page = await browser.newPage();
          await page.goto(
            `${GPO_GOV_BASE}/how-to-work-with-us/vendors/contract-opportunities`,
            { waitUntil: "domcontentloaded", timeout: 30000 }
          );
          const opps = await page.evaluate(() => {
            const items = [];
            const content = document.querySelector(".field--name-body, .node__content, main, article");
            if (!content) return items;
            const text = content.innerText;
            const blocks = text.split(/(?=Program\s*(?:No\.|Number|#)?:?\s*\d|Jacket\s*(?:No\.|Number|#)?:?\s*\d)/gi);
            for (const block of blocks) {
              if (block.trim().length < 20) continue;
              const jacketMatch = block.match(/(?:Program|Jacket)\s*(?:No\.|Number|#)?:?\s*([\d\-A-Z]+)/i);
              const titleMatch = block.match(/(?:Title|Description):?\s*(.+?)(?:\n|Bid|Due|Date|Quantity|$)/i);
              const dateMatch = block.match(/(?:Bid\s*Opening|Due\s*Date|Closing\s*Date):?\s*(.+?)(?:\n|$)/i);
              const typeMatch = block.match(/(Term\s*Contract|One[- ]Time\s*Bid)/i);
              if (jacketMatch || titleMatch) {
                items.push({
                  jacketNumber: jacketMatch ? jacketMatch[1].trim() : "",
                  title: titleMatch ? titleMatch[1].trim() : block.substring(0, 200).trim(),
                  deadline: dateMatch ? dateMatch[1].trim() : null,
                  contractType: typeMatch ? typeMatch[1].trim() : "Unknown",
                  rawText: block.substring(0, 500).trim(),
                });
              }
            }
            return items;
          });
          await page.close();

          for (const o of opps) {
            // Score term bids for MPA relevance
            const titleLower = (o.title || o.rawText || "").toLowerCase();
            let score = 10; // Base score for being a GPO opp
            const reasons = ["GPO term/one-time bid"];
            for (const kw of RELEVANCE_KEYWORDS) {
              if (titleLower.includes(kw)) {
                score += 25;
                reasons.push(`Keyword: "${kw}"`);
                break;
              }
            }
            const relevance = score >= 30 ? "HIGH" : score >= 15 ? "MEDIUM" : "LOW";
            allResults.push({
              id: `gpo-tc-${o.jacketNumber || Math.random().toString(36).substr(2, 8)}`,
              platform: "GPO Publish",
              type: o.contractType || "Term/One-Time",
              title: o.title || o.rawText?.substring(0, 200) || "",
              jacketNumber: o.jacketNumber || "",
              deadline: o.deadline,
              url: `${GPO_GOV_BASE}/how-to-work-with-us/vendors/contract-opportunities`,
              score,
              relevance,
              reasons,
              scoreReasons: reasons,
            });
          }
        } catch (e) {
          errors.push(`Term Bids: ${e.message}`);
        }
      }

      allResults.sort((a, b) => b.score - a.score);

      if (!allResults.length && errors.length) {
        return {
          content: [{ type: "text", text: `GPO scan failed:\n${errors.join("\n")}` }],
        };
      }

      const top = allResults.slice(0, 40);
      const lines = top.map(
        (o) =>
          `[${o.relevance} | Score ${o.score}] **${o.title}**\n` +
          `  Type: ${o.type} | Jacket: ${o.jacketNumber || "N/A"}\n` +
          `  Deadline: ${o.deadline ? (typeof o.deadline === "string" ? o.deadline : new Date(o.deadline).toLocaleString()) : "N/A"}\n` +
          `  ${o.url}\n` +
          `  Scoring: ${(o.scoreReasons || o.reasons || []).join(", ")}`
      );

      return {
        content: [
          {
            type: "text",
            text: `## GPO MPA Scan\nTotal: ${allResults.length} | Showing top ${top.length}${errors.length ? `\nErrors: ${errors.join("; ")}` : ""}\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );

  // ---- GPO Job Detail (single job by jacket number) ----
  server.tool(
    "gpo_job_detail",
    "Get detailed info for a specific GPO small purchase job by jacket number. Returns specs, attachments, and deadlines.",
    {
      jacket_number: z.string().describe("The GPO jacket number (e.g. '440410')"),
    },
    async (params) => {
      const res = await fetch(
        `${PUBLISH_BASE}/api/ContractorConnection/GetOpenJob?jacketNumber=${encodeURIComponent(params.jacket_number)}`,
        { headers: { Accept: "application/json" } }
      );
      if (!res.ok) throw new Error(`GPO API ${res.status}: ${await res.text().catch(() => "")}`);
      const job = await res.json();

      if (!job || (Array.isArray(job) && job.length === 0)) {
        return { content: [{ type: "text", text: `No job found for jacket number ${params.jacket_number}` }] };
      }

      const j = Array.isArray(job) ? job[0] : job;
      const text = [
        `## GPO Job Detail: ${j.jacketNumber}`,
        `**Title:** ${j.title || "N/A"}`,
        `**Product Type:** ${j.productType || "N/A"}`,
        `**Team:** ${j.officeName || "N/A"}`,
        `**Quantity:** ${j.totalQuantity || "N/A"}`,
        `**Quote Due:** ${j.quoteDueDate ? new Date(j.quoteDueDate).toLocaleString() : "N/A"}`,
        `**Date Posted:** ${j.datePosted ? new Date(j.datePosted).toLocaleDateString() : "N/A"}`,
        `**Ship/Delivery Date:** ${j.shipDeliveryDate ? new Date(j.shipDeliveryDate).toLocaleDateString() : "N/A"}`,
        `**Revision:** ${(j.fRevised || "").trim() || "None"}`,
        `**Strapped:** ${j.isJacketStrapped === "true" ? "Yes" : "No"}`,
        `**Attachments:** ${(j.attachmentFileNames || []).length > 0 ? (j.attachmentFileNames || []).join(", ") : "None"}`,
        `**Quote URL:** ${PUBLISH_BASE}/vendor/vendorQuote/${j.jacketNumber}`,
        `**RFQ Download:** Check the Small Purchase Opportunities page`,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ---- GPO Award Results Search ----
  server.tool(
    "gpo_award_results",
    "Search GPO small purchase award results to see past awards — useful for competitive intelligence and pricing analysis. Requires login.",
    {
      keyword: z.string().optional().describe("Search keyword for awarded jobs"),
      days_back: z.number().optional().describe("Days back to search (default 90)"),
    },
    async (params) => {
      // This endpoint requires auth — use browser login
      if (!GPO_EMAIL || !GPO_PASSWORD) {
        return { content: [{ type: "text", text: "GPO_EMAIL and GPO_PASSWORD not set in .env — required for award results." }] };
      }

      const { getBrowser } = await import("../lib/browser.js");
      const browser = await getBrowser();
      const page = await browser.newPage();

      try {
        // Login via IMS
        await page.goto(`${PUBLISH_BASE}/smallPurchase?activeTab=Pricing`, {
          waitUntil: "networkidle",
          timeout: 45000,
        });

        // If redirected to IMS login
        if (page.url().includes("ims.gpo.gov")) {
          await page.fill('input[name="username"], input[type="email"], #username', GPO_EMAIL);
          await page.fill('input[name="password"], input[type="password"], #password', GPO_PASSWORD);
          await page.click('button[type="submit"], input[type="submit"]');
          await page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 });
        }

        // Wait for the pricing/results table to load
        await page.waitForSelector("table, .dataTables_wrapper", { timeout: 15000 }).catch(() => {});

        // Extract award data from the table
        const awards = await page.evaluate(() => {
          const rows = document.querySelectorAll("table tbody tr");
          return Array.from(rows).slice(0, 50).map((row) => {
            const cells = row.querySelectorAll("td");
            return Array.from(cells).map((c) => c.textContent?.trim() || "");
          });
        });

        await page.close();

        if (!awards.length) {
          return { content: [{ type: "text", text: "No award results found (table may be empty or page format changed)." }] };
        }

        return {
          content: [
            {
              type: "text",
              text: `## GPO Award Results\nFound ${awards.length} recent awards.\n\n${awards.slice(0, 25).map((r) => r.join(" | ")).join("\n")}`,
            },
          ],
        };
      } catch (err) {
        await page.close().catch(() => {});
        throw new Error(`GPO award results failed: ${err.message}`);
      }
    }
  );
}

// Export for aggregator
export async function runGPOScan() {
  const results = [];

  // Small purchases via API (always available, no auth)
  try {
    const res = await fetch(`${PUBLISH_BASE}/api/ContractorConnection/GetOpenJobs`, {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const jobs = await res.json();
      for (const j of jobs) {
        const norm = normalizeSmallPurchase(j);
        const s = scoreGPOJob(norm);
        results.push({ ...norm, ...s, platform: "GPO Publish" });
      }
    }
  } catch {}

  // Term bids via browser
  try {
    const { getBrowser } = await import("../lib/browser.js");
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.goto(
      `${GPO_GOV_BASE}/how-to-work-with-us/vendors/contract-opportunities`,
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );
    const opps = await page.evaluate(() => {
      const items = [];
      const content = document.querySelector(".field--name-body, .node__content, main, article");
      if (!content) return items;
      const text = content.innerText;
      const blocks = text.split(/(?=Program\s*(?:No\.|Number|#)?:?\s*\d|Jacket\s*(?:No\.|Number|#)?:?\s*\d)/gi);
      for (const block of blocks) {
        if (block.trim().length < 20) continue;
        const jacketMatch = block.match(/(?:Program|Jacket)\s*(?:No\.|Number|#)?:?\s*([\d\-A-Z]+)/i);
        const titleMatch = block.match(/(?:Title|Description):?\s*(.+?)(?:\n|Bid|Due|Date|Quantity|$)/i);
        const dateMatch = block.match(/(?:Bid\s*Opening|Due\s*Date|Closing\s*Date):?\s*(.+?)(?:\n|$)/i);
        const typeMatch = block.match(/(Term\s*Contract|One[- ]Time\s*Bid)/i);
        if (jacketMatch || titleMatch) {
          items.push({
            jacketNumber: jacketMatch ? jacketMatch[1].trim() : "",
            title: titleMatch ? titleMatch[1].trim() : block.substring(0, 200).trim(),
            deadline: dateMatch ? dateMatch[1].trim() : null,
            contractType: typeMatch ? typeMatch[1].trim() : "Unknown",
          });
        }
      }
      return items;
    });
    await page.close();

    for (const o of opps) {
      const titleLower = (o.title || "").toLowerCase();
      let score = 10;
      const reasons = ["GPO term/one-time bid"];
      for (const kw of RELEVANCE_KEYWORDS) {
        if (titleLower.includes(kw)) {
          score += 25;
          reasons.push(`Keyword: "${kw}"`);
          break;
        }
      }
      const relevance = score >= 30 ? "HIGH" : score >= 15 ? "MEDIUM" : "LOW";
      results.push({
        id: `gpo-tc-${o.jacketNumber || Math.random().toString(36).substr(2, 8)}`,
        platform: "GPO Publish",
        type: o.contractType || "Term/One-Time",
        title: o.title || "",
        jacketNumber: o.jacketNumber || "",
        deadline: o.deadline,
        url: `${GPO_GOV_BASE}/how-to-work-with-us/vendors/contract-opportunities`,
        score,
        relevance,
        reasons,
      });
    }
  } catch {}

  return results;
}
