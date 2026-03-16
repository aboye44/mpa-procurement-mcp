import { z } from "zod";
import { newPage, safeWait } from "../lib/browser.js";
import { scoreOpportunity } from "../lib/scorer.js";
import { PORTAL_KEYWORDS } from "../lib/config.js";

// IonWave eProcurement — used by many FL cities
// Each agency has their own subdomain: {agency}.ionwave.net or {agency}.onwave.net
// Public bid listing is available without login at each instance
// Known FL users: Lauderhill, Lakeland, Lee County, Cape Coral, Gainesville, etc.

const IONWAVE_FL_AGENCIES = [
  { host: "lauderhill.ionwave.net", name: "City of Lauderhill" },
  { host: "legov.onwave.net", name: "Lee County" },
  { host: "capecoral.ionwave.net", name: "City of Cape Coral" },
  { host: "palmcoast.ionwave.net", name: "City of Palm Coast" },
  { host: "cityofgainesville.ionwave.net", name: "City of Gainesville" },
  { host: "portStlucie.ionwave.net", name: "City of Port St. Lucie" },
  { host: "cityoflakeland.ionwave.net", name: "City of Lakeland" },
  { host: "titusville.ionwave.net", name: "City of Titusville" },
  { host: "cityofcocoa.ionwave.net", name: "City of Cocoa" },
  { host: "winterhaven.ionwave.net", name: "City of Winter Haven" },
  { host: "cityofstuart.ionwave.net", name: "City of Stuart" },
  { host: "deltona.ionwave.net", name: "City of Deltona" },
  { host: "daytona.ionwave.net", name: "City of Daytona Beach" },
  { host: "kissimmee.ionwave.net", name: "City of Kissimmee" },
  { host: "sanford.ionwave.net", name: "City of Sanford" },
  { host: "palatka.ionwave.net", name: "City of Palatka" },
  { host: "taylorcofl.ionwave.net", name: "Taylor County" },
  { host: "nassaufl.ionwave.net", name: "Nassau County" },
  { host: "cityofocoee.ionwave.net", name: "City of Ocoee" },
  { host: "eustis.ionwave.net", name: "City of Eustis" },
];

async function scrapeIonWaveAgency(page, agency) {
  const results = [];
  // IonWave bid listings are typically at /bid-events or /bids
  const baseUrl = `https://${agency.host}`;

  try {
    // Try the main bid events page
    await page.goto(`${baseUrl}/bid-events`, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(2000);

    // Check if we got a valid page
    const pageTitle = await page.title();
    if (pageTitle.toLowerCase().includes("not found") || pageTitle.toLowerCase().includes("error")) {
      // Try alternate URL patterns
      await page.goto(`${baseUrl}/bids`, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Click "Available Bids" tab if present
    const availTab = await safeWait(page, "[class*='available' i], a:has-text('Available'), button:has-text('Available'), [class*='tab']:has-text('Available')", 3000);
    if (availTab) {
      await availTab.click().catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Extract bid listings
    const bids = await page.evaluate((agencyName) => {
      const items = [];
      // IonWave lists bids in table rows or card elements
      const rows = document.querySelectorAll(
        "table tbody tr, [class*='bid'], [class*='event'], [class*='solicitation'], [class*='card'], [class*='listing']"
      );

      rows.forEach((row) => {
        const titleEl = row.querySelector(
          "a, [class*='title'], [class*='name'], td:first-child a, td:nth-child(2) a, h3, h4"
        );
        const dateEl = row.querySelector(
          "[class*='date'], [class*='close'], [class*='deadline'], td:nth-child(3), td:nth-child(4), time"
        );
        const statusEl = row.querySelector(
          "[class*='status'], [class*='state'], td:last-child"
        );
        const idEl = row.querySelector(
          "[class*='number'], [class*='id'], td:first-child"
        );
        const link = row.querySelector("a[href]");

        if (titleEl?.textContent?.trim() && titleEl.textContent.trim().length > 5) {
          items.push({
            title: titleEl.textContent.trim(),
            agency: agencyName,
            deadline: dateEl?.textContent?.trim() || "",
            status: statusEl?.textContent?.trim() || "",
            bidNumber: idEl?.textContent?.trim() || "",
            url: link?.href || "",
          });
        }
      });
      return items;
    }, agency.name);

    for (const bid of bids) {
      const status = (bid.status || "").toLowerCase();
      if (status.includes("closed") || status.includes("awarded") || status.includes("cancelled")) continue;

      results.push({
        id: `ionwave-${agency.host.split(".")[0]}-${bid.bidNumber || bid.title}`.replace(/\s+/g, "-").toLowerCase().slice(0, 80),
        title: bid.title,
        platform: "IonWave",
        agency: bid.agency,
        state: "FL",
        status: bid.status || "open",
        deadline: bid.deadline || null,
        url: bid.url || `${baseUrl}/bid-events`,
        type: "Solicitation",
      });
    }
  } catch {
    // Agency instance may not exist or be structured differently
  }

  return results;
}

async function scrapeIonWave(keywords) {
  const page = await newPage();
  const results = [];

  try {
    for (const agency of IONWAVE_FL_AGENCIES) {
      const agencyResults = await scrapeIonWaveAgency(page, agency);
      results.push(...agencyResults);
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

export function registerIonWaveTools(server) {
  server.tool(
    "ionwave_scan",
    "Scan IonWave eProcurement portals for FL city procurement opportunities. Covers Lauderhill, Lee County, Cape Coral, Lakeland, Gainesville, and 15+ other FL cities that use IonWave for their bidding platform.",
    {
      keywords: z.array(z.string()).optional().describe("Custom keywords. Defaults to MPA's standard list."),
    },
    async (params) => {
      const opps = await scrapeIonWave(params.keywords || PORTAL_KEYWORDS);
      opps.forEach((o) => {
        const s = scoreOpportunity(o);
        o.score = s.score;
        o.relevance = s.relevance;
        o.scoreReasons = s.reasons;
      });
      opps.sort((a, b) => b.score - a.score);

      if (!opps.length) return { content: [{ type: "text", text: "No IonWave opportunities found." }] };
      const lines = opps.map(
        (o) =>
          `[${o.relevance} | Score ${o.score}] **${o.title}**\n  Agency: ${o.agency} | Deadline: ${o.deadline || "N/A"}\n  ${o.url}`
      );
      return {
        content: [
          {
            type: "text",
            text: `## IonWave Procurement Scan\nFound ${opps.length} opportunities across ${IONWAVE_FL_AGENCIES.length} FL agencies:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );

  server.tool(
    "ionwave_agency_list",
    "List all FL agencies tracked on IonWave eProcurement. Shows portal URLs for each agency.",
    {},
    async () => {
      const lines = IONWAVE_FL_AGENCIES.map(
        (a) => `- **${a.name}** → https://${a.host}/bid-events`
      );
      return {
        content: [
          {
            type: "text",
            text: `## IonWave FL Agencies (${IONWAVE_FL_AGENCIES.length})\n\n${lines.join("\n")}`,
          },
        ],
      };
    }
  );
}

export async function runIonWaveScan(keywords) {
  const opps = await scrapeIonWave(keywords || PORTAL_KEYWORDS);
  return opps.map((o) => {
    const s = scoreOpportunity(o);
    return { ...o, ...s };
  });
}
