import { z } from "zod";
import { upsertOpportunity, recordRun, exportFeed, getTrackedOpportunities, getRunHistory, dismissOpportunity } from "../lib/db.js";
import { closeBrowser } from "../lib/browser.js";
import { runSamScan } from "./sam-gov.js";
import { runDemandStarScan } from "./demandstar.js";
import { runMFMPScan } from "./mfmp.js";
import { runBonfireScan } from "./bonfire.js";
import { runBidNetScan } from "./bidnet.js";
import { runGPOScan } from "./gpo.js";
import { runBidSyncScan } from "./bidsync.js";
import { runOpenGovScan } from "./opengov.js";
import { runIonWaveScan } from "./ionwave.js";
import { runFLCountyScan } from "./fl-counties.js";
import { runFLVBSScan } from "./fl-vbs.js";
import { runUSPSScan } from "./usps.js";

export function registerAggregatorTools(server) {
  // ---- Full procurement scan (all 12 sources) ----
  server.tool(
    "full_procurement_scan",
    "Run a comprehensive procurement scan across ALL 12 sources: SAM.gov, DemandStar, MFMP, Bonfire, BidNet, GPO Publish, BidSync/Periscope S2G, OpenGov, IonWave, FL County Direct, FL VBS, and USPS. Deduplicates, scores, saves to tracker, and exports the feed. This is the one-command replacement for all procurement crons.",
    {
      days_back: z.number().optional().describe("Days back for SAM.gov (default 14)"),
      skip_portals: z.array(z.string()).optional().describe("Portal names to skip (e.g. ['mfmp', 'bonfire', 'ionwave'])"),
      quick_scan: z.boolean().optional().describe("Skip slower browser portals (BidSync, IonWave, FL Counties). Default false."),
    },
    async (params) => {
      const daysBack = params.days_back || 14;
      const skip = new Set((params.skip_portals || []).map((s) => s.toLowerCase()));
      const allResults = [];
      const errors = [];

      // SAM.gov (API - fastest, most reliable)
      if (!skip.has("sam.gov") && !skip.has("sam")) {
        try {
          const samResults = await runSamScan(daysBack);
          allResults.push(...samResults);
        } catch (e) { errors.push(`SAM.gov: ${e.message}`); }
      }

      // DemandStar (browser)
      if (!skip.has("demandstar")) {
        try {
          const dsResults = await runDemandStarScan();
          allResults.push(...dsResults);
        } catch (e) { errors.push(`DemandStar: ${e.message}`); }
      }

      // MFMP (browser)
      if (!skip.has("mfmp")) {
        try {
          const mfmpResults = await runMFMPScan();
          allResults.push(...mfmpResults);
        } catch (e) { errors.push(`MFMP: ${e.message}`); }
      }

      // Bonfire (browser)
      if (!skip.has("bonfire")) {
        try {
          const bonfireResults = await runBonfireScan();
          allResults.push(...bonfireResults);
        } catch (e) { errors.push(`Bonfire: ${e.message}`); }
      }

      // BidNet (browser)
      if (!skip.has("bidnet")) {
        try {
          const bidnetResults = await runBidNetScan();
          allResults.push(...bidnetResults);
        } catch (e) { errors.push(`BidNet: ${e.message}`); }
      }

      // GPO Publish (API + browser)
      if (!skip.has("gpo") && !skip.has("gpo publish")) {
        try {
          const gpoResults = await runGPOScan();
          allResults.push(...gpoResults);
        } catch (e) { errors.push(`GPO Publish: ${e.message}`); }
      }

      // BidSync / Periscope S2G (browser)
      if (!skip.has("bidsync") && !skip.has("periscope") && !params.quick_scan) {
        try {
          const bidsyncResults = await runBidSyncScan();
          allResults.push(...bidsyncResults);
        } catch (e) { errors.push(`BidSync: ${e.message}`); }
      }

      // OpenGov (browser)
      if (!skip.has("opengov")) {
        try {
          const opengovResults = await runOpenGovScan();
          allResults.push(...opengovResults);
        } catch (e) { errors.push(`OpenGov: ${e.message}`); }
      }

      // IonWave (browser)
      if (!skip.has("ionwave") && !params.quick_scan) {
        try {
          const ionwaveResults = await runIonWaveScan();
          allResults.push(...ionwaveResults);
        } catch (e) { errors.push(`IonWave: ${e.message}`); }
      }

      // FL County Direct (browser)
      if (!skip.has("county") && !skip.has("fl county") && !skip.has("counties") && !params.quick_scan) {
        try {
          const countyResults = await runFLCountyScan();
          allResults.push(...countyResults);
        } catch (e) { errors.push(`FL Counties: ${e.message}`); }
      }

      // FL VBS (browser)
      if (!skip.has("vbs") && !skip.has("fl vbs")) {
        try {
          const vbsResults = await runFLVBSScan();
          allResults.push(...vbsResults);
        } catch (e) { errors.push(`FL VBS: ${e.message}`); }
      }

      // USPS (browser)
      if (!skip.has("usps")) {
        try {
          const uspsResults = await runUSPSScan();
          allResults.push(...uspsResults);
        } catch (e) { errors.push(`USPS: ${e.message}`); }
      }

      // Close shared browser
      await closeBrowser();

      // Save to tracker
      const saveResults = [];
      for (const opp of allResults) {
        const result = upsertOpportunity(opp);
        saveResults.push({ ...result, platform: opp.platform });
      }

      // Record runs per platform
      const byPlatform = {};
      for (const r of saveResults) {
        if (!byPlatform[r.platform]) byPlatform[r.platform] = [];
        byPlatform[r.platform].push(r);
      }
      for (const [platform, results] of Object.entries(byPlatform)) {
        recordRun(platform, results);
      }

      // Export feed
      const feed = exportFeed();
      const newCount = saveResults.filter((r) => r.isNew).length;

      // Build summary
      const platformSummary = Object.entries(byPlatform)
        .map(([p, r]) => `  ${p}: ${r.length} found, ${r.filter((x) => x.isNew).length} new`)
        .join("\n");

      const topNew = allResults
        .filter((o) => saveResults.find((r) => r.id === o.id && r.isNew))
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 10)
        .map((o) => `  [${o.relevance}] **${o.title}** (${o.platform})\n    ${o.agency || ""} | Deadline: ${o.deadline || "N/A"}\n    ${o.url || ""}`)
        .join("\n\n");

      const errorStr = errors.length ? `\n\n**Errors:**\n${errors.map((e) => `  - ${e}`).join("\n")}` : "";

      return {
        content: [{
          type: "text",
          text: `## Full Procurement Scan Complete\n\n**Total found:** ${allResults.length}\n**New opportunities:** ${newCount}\n**Total tracked:** ${feed.total}\n**Feed exported to:** ${process.env.FEED_PATH || "data/procurement_feed.json"}\n\n**By platform:**\n${platformSummary}${topNew ? `\n\n**Top new opportunities:**\n${topNew}` : ""}${errorStr}`,
        }],
      };
    }
  );

  // ---- View tracked opportunities ----
  server.tool(
    "list_tracked",
    "List all tracked procurement opportunities with scores and status. Shows the current state of the procurement pipeline.",
    {
      relevance: z.enum(["HIGH", "MEDIUM", "LOW", "ALL"]).optional().describe("Filter by relevance (default ALL)"),
      platform: z.string().optional().describe("Filter by platform name"),
      active_only: z.boolean().optional().describe("Only show non-dismissed opportunities (default true)"),
    },
    async (params) => {
      const opps = getTrackedOpportunities();
      let list = Object.values(opps);
      if (params.relevance && params.relevance !== "ALL") list = list.filter((o) => o.relevance === params.relevance);
      if (params.platform) list = list.filter((o) => o.platform?.toLowerCase() === params.platform.toLowerCase());
      if (params.active_only !== false) list = list.filter((o) => o.status !== "dismissed");
      list.sort((a, b) => (b.score || 0) - (a.score || 0));

      if (!list.length) return { content: [{ type: "text", text: "No tracked opportunities matching filters." }] };
      const lines = list.map((o) => `[${o.relevance || "?"} | Score ${o.score || 0}] **${o.title}**\n  Platform: ${o.platform} | Agency: ${o.agency || "N/A"}\n  Deadline: ${o.deadline || "N/A"} | Found: ${o.foundDate || "N/A"}\n  ${o.url || ""}`);
      return { content: [{ type: "text", text: `## Tracked Opportunities (${list.length})\n\n${lines.join("\n\n")}` }] };
    }
  );

  // ---- Dismiss opportunity ----
  server.tool(
    "dismiss_opportunity",
    "Mark an opportunity as dismissed so it doesn't show up in future scans.",
    { id: z.string().describe("Opportunity ID to dismiss") },
    async (params) => {
      const ok = dismissOpportunity(params.id);
      return { content: [{ type: "text", text: ok ? `Dismissed: ${params.id}` : `Not found: ${params.id}` }] };
    }
  );

  // ---- Run history ----
  server.tool(
    "scan_history",
    "View the history of procurement scan runs — when each portal was last checked and what was found.",
    { platform: z.string().optional().describe("Filter by platform name") },
    async (params) => {
      const history = getRunHistory(params.platform);
      const recent = history.slice(-20);
      if (!recent.length) return { content: [{ type: "text", text: "No scan history yet." }] };
      const lines = recent.map((r) => `${r.timestamp} | ${r.platform} | Found: ${r.found} | New: ${r.newCount}`);
      return { content: [{ type: "text", text: `## Scan History (last ${recent.length} runs)\n\n${lines.join("\n")}` }] };
    }
  );

  // ---- Export feed ----
  server.tool(
    "export_feed",
    "Export the current procurement tracker to the JSON feed file. Useful for refreshing the Command Center data.",
    {},
    async () => {
      const feed = exportFeed();
      return { content: [{ type: "text", text: `Feed exported: ${feed.total} opportunities\nPath: ${process.env.FEED_PATH || "data/procurement_feed.json"}` }] };
    }
  );
}
