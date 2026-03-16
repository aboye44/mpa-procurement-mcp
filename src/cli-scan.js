#!/usr/bin/env node

/**
 * CLI entry point for scheduled scans.
 * Run via: node src/cli-scan.js [--sam-only] [--portals-only] [--days 14]
 * 
 * Use with Claude Code scheduled tasks:
 *   claude task add "Run MPA procurement scan" --schedule "0 12,18 * * 1-5" --command "node C:/path/to/mpa-procurement-mcp/src/cli-scan.js"
 * 
 * Or with Windows Task Scheduler / cron.
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

import { upsertOpportunity, recordRun, exportFeed } from "./lib/db.js";
import { closeBrowser } from "./lib/browser.js";
import { runSamScan } from "./tools/sam-gov.js";
import { runDemandStarScan } from "./tools/demandstar.js";
import { runMFMPScan } from "./tools/mfmp.js";
import { runBonfireScan } from "./tools/bonfire.js";
import { runBidNetScan } from "./tools/bidnet.js";

const args = process.argv.slice(2);
const samOnly = args.includes("--sam-only");
const portalsOnly = args.includes("--portals-only");
const daysIdx = args.indexOf("--days");
const daysBack = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) || 14 : 14;

async function run() {
  const start = Date.now();
  console.log(`[${new Date().toISOString()}] MPA Procurement Scan starting...`);
  const allResults = [];
  const errors = [];

  if (!portalsOnly) {
    console.log("  Scanning SAM.gov...");
    try {
      const r = await runSamScan(daysBack);
      allResults.push(...r);
      console.log(`  SAM.gov: ${r.length} found`);
    } catch (e) { errors.push(`SAM.gov: ${e.message}`); console.error(`  SAM.gov error: ${e.message}`); }
  }

  if (!samOnly) {
    for (const [name, fn] of [["DemandStar", runDemandStarScan], ["MFMP", runMFMPScan], ["Bonfire", runBonfireScan], ["BidNet", runBidNetScan]]) {
      console.log(`  Scanning ${name}...`);
      try {
        const r = await fn();
        allResults.push(...r);
        console.log(`  ${name}: ${r.length} found`);
      } catch (e) { errors.push(`${name}: ${e.message}`); console.error(`  ${name} error: ${e.message}`); }
    }
    await closeBrowser();
  }

  // Save
  const saveResults = [];
  for (const opp of allResults) {
    const result = upsertOpportunity(opp);
    saveResults.push({ ...result, platform: opp.platform });
  }

  const byPlatform = {};
  for (const r of saveResults) {
    if (!byPlatform[r.platform]) byPlatform[r.platform] = [];
    byPlatform[r.platform].push(r);
  }
  for (const [platform, results] of Object.entries(byPlatform)) {
    recordRun(platform, results);
  }

  const feed = exportFeed();
  const newCount = saveResults.filter((r) => r.isNew).length;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n[${new Date().toISOString()}] Scan complete in ${elapsed}s`);
  console.log(`  Total found: ${allResults.length}`);
  console.log(`  New: ${newCount}`);
  console.log(`  Total tracked: ${feed.total}`);
  if (errors.length) console.log(`  Errors: ${errors.join("; ")}`);

  // Print new opportunities
  if (newCount > 0) {
    console.log(`\n  NEW OPPORTUNITIES:`);
    const newOpps = allResults.filter((o) => saveResults.find((r) => r.id === o.id && r.isNew));
    newOpps.sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const o of newOpps.slice(0, 10)) {
      console.log(`    [${o.relevance}] ${o.title} (${o.platform})`);
      console.log(`      Deadline: ${o.deadline || "N/A"} | ${o.url || ""}`);
    }
  }
}

run().catch((e) => { console.error("Fatal:", e); process.exit(1); });
