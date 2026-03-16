/**
 * Google Sheets MCP Tools — Score, dedup, upsert, and manage procurement
 * opportunities in the MPA Procurement Pipeline Google Sheet.
 *
 * v2.1 improvements (ai-agent-super-skill audit):
 * - Batch API calls: rescore uses 2 API calls instead of 102
 * - structuredContent on all tools for programmatic chaining
 * - Tool annotations (readOnlyHint, destructiveHint, idempotentHint)
 * - Enum constraints on competition, complexity, contractType
 * - Actionable error messages with remediation hints
 * - Deadline staleness auto-detection (auto-marks EXPIRED)
 */
import { z } from "zod";
import {
  readRange,
  appendRows,
  updateRange,
  batchValueUpdate,
  batchUpdate,
  buildGoNoGoFormat,
  buildScoreFormat,
  buildNewRowFormats,
} from "../lib/sheets-client.js";
import { scoreOpportunity, daysUntil } from "../lib/scoring.js";
import { runFullScan } from "./aggregator.js";

// ---- Constants ----

const COLUMNS = [
  "Opportunity", "Agency", "Portal", "State", "Deadline",
  "Est. Value", "Score", "MPA Fit", "ROI", "Go/No-Go",
  "Reasons", "URL", "Status", "Found Date", "Last Updated",
];

const today = () => new Date().toISOString().split("T")[0];

// ---- Shared schemas ----

const OpportunitySchema = z.object({
  title: z.string().describe("Opportunity title or solicitation number"),
  agency: z.string().describe("Issuing organization"),
  portal: z.string().describe("Source portal (SAM.gov, DemandStar, MFMP, Bonfire, BidNet, GPO, BidSync, OpenGov, IonWave, FL County, FL VBS, USPS)"),
  state: z.string().optional().describe("State abbreviation or name (FL preferred)"),
  deadline: z.string().optional().describe("Response due date (YYYY-MM-DD or human-readable)"),
  estValue: z.string().optional().describe("Estimated dollar value ($50K, $1.2M, etc.)"),
  url: z.string().optional().describe("Direct link to opportunity listing"),
  description: z.string().optional().describe("Brief description for better scoring accuracy"),
  contractType: z.enum([
    "multi-year", "idiq", "bpa", "annual", "recurring",
    "one-time", "one-time-renewal", "unknown",
  ]).optional().describe("Contract type — affects ROI score"),
  competition: z.enum([
    "small-business", "set-aside", "limited", "sole-source",
    "open", "incumbent", "unknown",
  ]).optional().describe("Competition level — affects ROI score"),
  complexity: z.enum(["low", "medium", "high", "unknown"]).optional()
    .describe("Effort complexity — low=standard print/mail, high=custom/complex"),
});

// ---- Helper functions ----

function buildRow(opp, scoring) {
  return [
    opp.title || opp.opportunity || "",
    opp.agency || "",
    opp.portal || opp.platform || "",
    opp.state || "",
    opp.deadline || "",
    opp.estValue || opp.est_value || "Unknown",
    String(scoring.score),
    scoring.mpaFit,
    scoring.roi,
    scoring.decision,
    scoring.reasons,
    opp.url || "",
    "NEW",
    today(),
    today(),
  ];
}

function normalizeTitle(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDuplicate(opp, existingRow) {
  const existingTitle = normalizeTitle(existingRow[0]);
  const existingAgency = (existingRow[1] || "").toLowerCase().trim();
  const existingUrl = (existingRow[11] || "").toLowerCase().trim();

  const newTitle = normalizeTitle(opp.title || opp.opportunity || "");
  const newAgency = (opp.agency || "").toLowerCase().trim();
  const newUrl = (opp.url || "").toLowerCase().trim();

  // Exact title + agency match
  if (existingTitle && newTitle && existingTitle === newTitle && existingAgency === newAgency) {
    return true;
  }

  // URL match
  if (existingUrl && newUrl && existingUrl === newUrl) {
    return true;
  }

  // Fuzzy title containment (for slight variations)
  if (existingTitle && newTitle && existingTitle.length > 10 && newTitle.length > 10) {
    if (existingTitle.includes(newTitle) || newTitle.includes(existingTitle)) {
      if (!existingAgency || !newAgency || existingAgency.includes(newAgency) || newAgency.includes(existingAgency)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Build an actionable error message with remediation hint.
 */
function buildError(title, err) {
  const msg = err.message || String(err);
  let remediation;

  if (msg.includes("PERMISSION_DENIED") || msg.includes("403")) {
    remediation = "The service account doesn't have Editor access to this sheet. " +
      "Open the sheet → Share → paste the service account email → set to Editor.";
  } else if (msg.includes("NOT_FOUND") || msg.includes("404")) {
    remediation = "Sheet not found. Check PROCUREMENT_SHEET_ID in .env matches the spreadsheet URL. " +
      "Current ID should be: 1ze-9C0g924sotn3emm5j7N_jtw-MvRiBWDrh1T1tJa8";
  } else if (msg.includes("INVALID_ARGUMENT") || msg.includes("400")) {
    remediation = `Check that the opportunity data is valid. Title: "${title}". ` +
      "Ensure no fields contain control characters or exceed cell limits.";
  } else if (msg.includes("UNAUTHENTICATED") || msg.includes("401")) {
    remediation = "Service account auth failed. The JSON key may be expired or corrupted. " +
      "Generate a new key: Google Cloud Console → IAM → Service Accounts → Keys → Add Key.";
  } else if (msg.includes("RATE_LIMIT") || msg.includes("429")) {
    remediation = "Google Sheets API rate limit hit (100 requests/100 seconds). " +
      "Wait 60 seconds and retry. Consider using force_update=false to skip unchanged rows.";
  } else {
    remediation = "Retry the operation. If persistent, check GOOGLE_SHEETS_CREDS_PATH and PROCUREMENT_SHEET_ID in .env. " +
      "Run `node -e \"require('./src/lib/sheets-client.js')\"` to test auth.";
  }

  return { title, error: msg, remediation };
}

// ---- Tool registration ----

export function registerSheetsTools(server) {

  // ==== push_to_sheet ====
  server.tool(
    "push_to_sheet",
    "Score, deduplicate, and push procurement opportunities to the MPA Google Sheet. Accepts an array of opportunities, scores each with the go/no-go engine, deduplicates against existing data, upserts new/updated rows, and applies formatting. Returns structured results for chaining.",
    {
      opportunities: z.array(OpportunitySchema)
        .min(1).max(200)
        .describe("Array of procurement opportunities to push (1-200)"),
      force_update: z.boolean().optional().describe("Force update even if duplicate exists (re-scores and overwrites). Default false."),
      dry_run: z.boolean().optional().describe("Score and check for dupes but don't write to sheet. Default false."),
    },
    async (params) => {
      const { opportunities, force_update = false, dry_run = false } = params;

      // 1. Read existing sheet data
      let existing;
      try {
        existing = await readRange("A:O");
      } catch (err) {
        const errInfo = buildError("sheet_read", err);
        return {
          content: [{ type: "text", text: `Error reading sheet: ${errInfo.error}\n\n${errInfo.remediation}` }],
          structuredContent: { success: false, error: errInfo },
        };
      }

      // If empty, add headers
      if (existing.length === 0) {
        if (!dry_run) await appendRows([COLUMNS]);
        existing = [COLUMNS];
      }

      const dataRows = existing.slice(1);
      const results = { added: [], updated: [], skipped: [], errors: [] };

      // Collect batch operations
      const newRows = [];
      const valueUpdates = [];
      const formatRequests = [];

      for (const opp of opportunities) {
        try {
          const scoring = scoreOpportunity(opp);
          const row = buildRow(opp, scoring);

          // Dedup check
          let dupeIndex = -1;
          for (let i = 0; i < dataRows.length; i++) {
            if (isDuplicate(opp, dataRows[i])) {
              dupeIndex = i;
              break;
            }
          }

          if (dupeIndex >= 0 && !force_update) {
            results.skipped.push({
              title: opp.title, reason: `Duplicate of row ${dupeIndex + 2}`,
              score: scoring.score, decision: scoring.decision,
            });
            continue;
          }

          if (dry_run) {
            const entry = { title: opp.title, score: scoring.score, decision: scoring.decision, reasons: scoring.reasons };
            if (dupeIndex >= 0) {
              results.updated.push({ ...entry, row: dupeIndex + 2 });
            } else {
              results.added.push(entry);
            }
            continue;
          }

          if (dupeIndex >= 0 && force_update) {
            // Upsert: update existing row
            const existingStatus = dataRows[dupeIndex][12] || "NEW";
            row[12] = existingStatus;
            row[13] = dataRows[dupeIndex][13] || today();
            row[14] = today();

            const rowNum = dupeIndex + 2;
            valueUpdates.push({ range: `A${rowNum}:O${rowNum}`, values: [row] });
            formatRequests.push(buildGoNoGoFormat(rowNum - 1, scoring.decision));
            formatRequests.push(buildScoreFormat(rowNum - 1, scoring.score));
            results.updated.push({ title: opp.title, row: rowNum, score: scoring.score, decision: scoring.decision });
          } else {
            // Append: collect new rows for batch append
            newRows.push({ row, scoring, opp });
            results.added.push({ title: opp.title, score: scoring.score, decision: scoring.decision });
          }
        } catch (err) {
          results.errors.push(buildError(opp.title, err));
        }
      }

      // 2. Execute batch operations (not dry_run)
      if (!dry_run) {
        // Batch upsert existing rows
        if (valueUpdates.length) {
          await batchValueUpdate(valueUpdates);
        }

        // Batch append new rows
        if (newRows.length) {
          await appendRows(newRows.map((r) => r.row));

          // Build formatting for new rows
          const startRow = existing.length;
          for (let i = 0; i < newRows.length; i++) {
            const rowIdx = startRow + i;
            formatRequests.push(buildGoNoGoFormat(rowIdx, newRows[i].scoring.decision));
            formatRequests.push(buildScoreFormat(rowIdx, newRows[i].scoring.score));
          }
          formatRequests.push(...buildNewRowFormats(startRow, startRow + newRows.length));
        }

        // Single batch formatting call
        if (formatRequests.length) {
          try {
            await batchUpdate(formatRequests);
          } catch {
            // Non-fatal — formatting is cosmetic
          }
        }
      }

      // 3. Build summary
      const bidCount = [...results.added, ...results.updated].filter((r) => r.decision === "BID").length;
      const reviewCount = [...results.added, ...results.updated].filter((r) => r.decision === "REVIEW").length;

      let summary = `## push_to_sheet Results${dry_run ? " (DRY RUN)" : ""}\n\n`;
      summary += `**Processed:** ${opportunities.length} | **Added:** ${results.added.length} | **Updated:** ${results.updated.length} | **Skipped:** ${results.skipped.length} | **Errors:** ${results.errors.length}\n`;
      summary += `**BID recs:** ${bidCount} | **REVIEW:** ${reviewCount}\n\n`;

      if (results.added.length) {
        summary += "**New:**\n";
        for (const r of results.added) summary += `  [${r.decision}] ${r.score}/100 — ${r.title}\n`;
        summary += "\n";
      }
      if (results.updated.length) {
        summary += "**Updated:**\n";
        for (const r of results.updated) summary += `  [${r.decision}] ${r.score}/100 — ${r.title} (row ${r.row})\n`;
        summary += "\n";
      }
      if (results.skipped.length) {
        summary += "**Skipped (duplicates):**\n";
        for (const r of results.skipped) summary += `  ${r.title} — ${r.reason}\n`;
        summary += "\n";
      }
      if (results.errors.length) {
        summary += "**Errors:**\n";
        for (const r of results.errors) summary += `  ${r.title} — ${r.error}\n  Fix: ${r.remediation}\n`;
      }

      return {
        content: [{ type: "text", text: summary }],
        structuredContent: {
          success: results.errors.length === 0,
          dry_run,
          processed: opportunities.length,
          added: results.added,
          updated: results.updated,
          skipped: results.skipped,
          errors: results.errors,
          bidCount,
          reviewCount,
          totalInSheet: existing.length - 1 + results.added.length,
        },
      };
    }
  );

  // ==== rescore_sheet ====
  server.tool(
    "rescore_sheet",
    "Re-score all opportunities in the Google Sheet using the current scoring engine. Updates Score, MPA Fit, ROI, Go/No-Go, Reasons, and Last Updated. Auto-marks opportunities with passed deadlines as EXPIRED. Uses batch API calls (2 calls total instead of 3 per row).",
    {
      confirm: z.boolean().describe("Set to true to confirm. This overwrites scoring columns for ALL rows."),
      auto_expire: z.boolean().optional().describe("Auto-set Status to EXPIRED for passed deadlines. Default true."),
    },
    async (params) => {
      if (!params.confirm) {
        return {
          content: [{ type: "text", text: "Set confirm=true to re-score all rows. This will overwrite columns G-K and O, and optionally auto-expire passed deadlines." }],
          structuredContent: { success: false, reason: "confirmation_required" },
        };
      }

      const autoExpire = params.auto_expire !== false;
      let existing;
      try {
        existing = await readRange("A:O");
      } catch (err) {
        const errInfo = buildError("sheet_read", err);
        return {
          content: [{ type: "text", text: `Error: ${errInfo.error}\n${errInfo.remediation}` }],
          structuredContent: { success: false, error: errInfo },
        };
      }

      if (existing.length <= 1) {
        return {
          content: [{ type: "text", text: "Sheet is empty or has only headers." }],
          structuredContent: { success: true, updated: 0 },
        };
      }

      const dataRows = existing.slice(1);
      const valueUpdates = [];
      const formatRequests = [];
      let updated = 0;
      let expired = 0;
      const changes = [];

      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const opp = {
          title: row[0] || "",
          agency: row[1] || "",
          portal: row[2] || "",
          state: row[3] || "",
          deadline: row[4] || "",
          estValue: row[5] || "",
          url: row[11] || "",
        };

        const scoring = scoreOpportunity(opp);
        const rowNum = i + 2;
        const oldDecision = row[9] || "";
        const oldScore = row[6] || "";
        const currentStatus = row[12] || "NEW";

        // Check for deadline expiry
        let newStatus = null;
        if (autoExpire && opp.deadline) {
          const days = daysUntil(opp.deadline);
          if (days !== null && days < 0 && currentStatus === "NEW") {
            newStatus = "EXPIRED";
            expired++;
          }
        }

        // Batch: update scoring columns G-K + Last Updated O
        const scoringValues = [
          String(scoring.score), scoring.mpaFit, scoring.roi,
          scoring.decision, scoring.reasons,
        ];
        valueUpdates.push({ range: `G${rowNum}:K${rowNum}`, values: [scoringValues] });
        valueUpdates.push({ range: `O${rowNum}`, values: [[today()]] });

        // Batch: update status if expired
        if (newStatus) {
          valueUpdates.push({ range: `M${rowNum}`, values: [[newStatus]] });
        }

        // Batch: formatting
        formatRequests.push(buildGoNoGoFormat(rowNum - 1, scoring.decision));
        formatRequests.push(buildScoreFormat(rowNum - 1, scoring.score));

        // Track changes
        if (oldDecision !== scoring.decision || oldScore !== String(scoring.score)) {
          changes.push({
            title: opp.title, row: rowNum,
            oldScore: oldScore, newScore: scoring.score,
            oldDecision, newDecision: scoring.decision,
            expired: !!newStatus,
          });
        }
        updated++;
      }

      // Execute: 1 batch value update + 1 batch format update = 2 API calls
      await batchValueUpdate(valueUpdates);
      await batchUpdate(formatRequests);

      // Summary
      let text = `## Rescore Complete\n\n`;
      text += `**Rows updated:** ${updated} | **Auto-expired:** ${expired}\n\n`;

      if (changes.length) {
        text += `**Score changes (${changes.length}):**\n`;
        for (const c of changes.slice(0, 20)) {
          text += `  Row ${c.row}: ${c.oldScore}→${c.newScore} [${c.oldDecision}→${c.newDecision}]${c.expired ? " ⚠ EXPIRED" : ""} — ${c.title}\n`;
        }
        if (changes.length > 20) text += `  ... and ${changes.length - 20} more\n`;
      } else {
        text += "No score changes detected.\n";
      }

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          success: true,
          updated,
          expired,
          changes,
          apiCalls: 2,
        },
      };
    }
  );

  // ==== scan_and_push: Full pipeline orchestrator ====
  server.tool(
    "scan_and_push",
    "Full procurement pipeline in one command: scan all 12 portals → score with go/no-go engine → deduplicate → push new opportunities to Google Sheet → return summary. This is the single-command replacement for running full_procurement_scan + push_to_sheet separately.",
    {
      days_back: z.number().optional().describe("Days back for SAM.gov (default 14)"),
      skip_portals: z.array(z.string()).optional().describe("Portal names to skip"),
      quick_scan: z.boolean().optional().describe("Skip slower browser portals (BidSync, IonWave, FL Counties). Default false."),
      dry_run: z.boolean().optional().describe("Scan and score but don't write to sheet. Default false."),
    },
    async (params) => {
      const { dry_run = false, ...scanParams } = params;

      // Step 1: Scan all portals
      let scanResult;
      try {
        scanResult = await runFullScan(scanParams);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Scan failed: ${err.message}` }],
          structuredContent: { success: false, phase: "scan", error: err.message },
        };
      }

      const { results: rawResults, errors: scanErrors } = scanResult;

      if (!rawResults.length && !scanErrors.length) {
        return {
          content: [{ type: "text", text: "Scan returned no results and no errors. All portals may be down." }],
          structuredContent: { success: true, phase: "scan", found: 0, scanErrors: [] },
        };
      }

      // Step 2: Map portal results to push_to_sheet format
      const opportunities = rawResults.map((opp) => ({
        title: opp.title || opp.solicitation || "",
        agency: opp.agency || opp.department || "",
        portal: opp.platform || opp.portal || "Unknown",
        state: opp.state || opp.location || "",
        deadline: opp.deadline || opp.responseDate || "",
        estValue: opp.estimatedValue || opp.value || opp.est_value || "Unknown",
        url: opp.url || opp.link || "",
        description: opp.description || opp.title || "",
        contractType: opp.contractType || "unknown",
        competition: opp.competition || opp.setAside || "unknown",
        complexity: "unknown",
      }));

      // Step 3: Read existing sheet, score, dedup, push
      let existing;
      try {
        existing = await readRange("A:O");
      } catch (err) {
        return {
          content: [{ type: "text", text: `Scan found ${rawResults.length} opportunities but sheet read failed: ${err.message}` }],
          structuredContent: { success: false, phase: "sheet_read", found: rawResults.length, error: err.message },
        };
      }

      if (existing.length === 0) {
        if (!dry_run) await appendRows([COLUMNS]);
        existing = [COLUMNS];
      }

      const dataRows = existing.slice(1);
      const results = { added: [], updated: [], skipped: [], errors: [] };
      const newRows = [];
      const formatRequests = [];

      for (const opp of opportunities) {
        try {
          const scoring = scoreOpportunity(opp);
          const row = buildRow(opp, scoring);

          // Dedup
          let dupeIndex = -1;
          for (let i = 0; i < dataRows.length; i++) {
            if (isDuplicate(opp, dataRows[i])) { dupeIndex = i; break; }
          }

          if (dupeIndex >= 0) {
            results.skipped.push({ title: opp.title, score: scoring.score, decision: scoring.decision, reason: `Duplicate of row ${dupeIndex + 2}` });
            continue;
          }

          if (dry_run) {
            results.added.push({ title: opp.title, score: scoring.score, decision: scoring.decision, portal: opp.portal });
            continue;
          }

          newRows.push({ row, scoring, opp });
          results.added.push({ title: opp.title, score: scoring.score, decision: scoring.decision, portal: opp.portal });
        } catch (err) {
          results.errors.push(buildError(opp.title, err));
        }
      }

      // Step 4: Batch write
      if (!dry_run && newRows.length) {
        await appendRows(newRows.map((r) => r.row));

        const startRow = existing.length;
        for (let i = 0; i < newRows.length; i++) {
          const rowIdx = startRow + i;
          formatRequests.push(buildGoNoGoFormat(rowIdx, newRows[i].scoring.decision));
          formatRequests.push(buildScoreFormat(rowIdx, newRows[i].scoring.score));
        }
        formatRequests.push(...buildNewRowFormats(startRow, startRow + newRows.length));

        try { await batchUpdate(formatRequests); } catch { /* cosmetic */ }
      }

      // Step 5: Summary
      const bidCount = results.added.filter((r) => r.decision === "BID").length;
      const reviewCount = results.added.filter((r) => r.decision === "REVIEW").length;

      let text = `## Scan & Push Complete${dry_run ? " (DRY RUN)" : ""}\n\n`;
      text += `**Scanned:** ${rawResults.length} from portals | **New to sheet:** ${results.added.length} | **Duplicates skipped:** ${results.skipped.length}\n`;
      text += `**BID:** ${bidCount} | **REVIEW:** ${reviewCount}\n`;
      if (scanErrors.length) text += `**Portal errors:** ${scanErrors.length} (${scanErrors.join("; ")})\n`;
      text += "\n";

      if (results.added.length) {
        text += "**New opportunities:**\n";
        for (const r of results.added.sort((a, b) => b.score - a.score)) {
          text += `  [${r.decision}] ${r.score}/100 — ${r.title} (${r.portal})\n`;
        }
      } else {
        text += "No new opportunities found this scan.\n";
      }

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          success: true,
          dry_run,
          scanned: rawResults.length,
          added: results.added,
          skipped: results.skipped,
          errors: results.errors,
          scanErrors,
          bidCount,
          reviewCount,
          totalInSheet: existing.length - 1 + (dry_run ? 0 : results.added.length),
        },
      };
    }
  );

  // ==== sheet_status ====
  server.tool(
    "sheet_status",
    "Quick status summary of the MPA procurement pipeline — counts by decision and status, top opportunities, and deadline alerts.",
    {},
    async () => {
      let existing;
      try {
        existing = await readRange("A:O");
      } catch (err) {
        const errInfo = buildError("sheet_read", err);
        return {
          content: [{ type: "text", text: `Error: ${errInfo.error}\n${errInfo.remediation}` }],
          structuredContent: { success: false, error: errInfo },
        };
      }

      if (existing.length <= 1) {
        return {
          content: [{ type: "text", text: "Pipeline is empty." }],
          structuredContent: { success: true, total: 0 },
        };
      }

      const rows = existing.slice(1);
      const total = rows.length;

      // Counts
      const decisions = { BID: 0, REVIEW: 0, SKIP: 0 };
      const statuses = {};
      const deadlineAlerts = [];

      for (const row of rows) {
        const d = (row[9] || "").toUpperCase();
        if (decisions[d] !== undefined) decisions[d]++;

        const s = row[12] || "UNKNOWN";
        statuses[s] = (statuses[s] || 0) + 1;

        // Deadline alerts: upcoming in next 7 days
        if (row[4] && (row[12] || "NEW") === "NEW") {
          const days = daysUntil(row[4]);
          if (days !== null && days >= 0 && days <= 7) {
            deadlineAlerts.push({ title: row[0], deadline: row[4], daysLeft: days, decision: row[9] });
          }
        }
      }

      // Top 5 by score
      const top5 = rows
        .map((r, i) => ({ title: r[0], score: parseInt(r[6]) || 0, decision: r[9], status: r[12], row: i + 2 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      let text = `## MPA Procurement Pipeline\n\n`;
      text += `**Total:** ${total} | **BID:** ${decisions.BID} | **REVIEW:** ${decisions.REVIEW} | **SKIP:** ${decisions.SKIP}\n\n`;

      text += `**By status:**\n`;
      for (const [s, c] of Object.entries(statuses).sort((a, b) => b[1] - a[1])) {
        text += `  ${s}: ${c}\n`;
      }

      if (deadlineAlerts.length) {
        text += `\n**Deadline alerts (next 7 days):**\n`;
        for (const a of deadlineAlerts) {
          text += `  [${a.decision}] ${a.title} — ${a.daysLeft} days left (${a.deadline})\n`;
        }
      }

      text += `\n**Top 5:**\n`;
      for (const o of top5) {
        text += `  [${o.decision}] ${o.score}/100 — ${o.title} (${o.status || "NEW"})\n`;
      }

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          success: true,
          total,
          decisions,
          statuses,
          deadlineAlerts,
          top5,
        },
      };
    }
  );
}
