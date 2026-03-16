/**
 * push_to_sheet MCP Tool — Score, dedup, upsert, and format procurement
 * opportunities into the MPA Procurement Pipeline Google Sheet.
 *
 * Uses direct Google Sheets API (~200-400ms/call) instead of Pipedream (1.5-5.7s/call).
 */
import { z } from "zod";
import {
  readRange,
  appendRows,
  updateRange,
  formatNewRows,
  colorGoNoGoCell,
  colorScoreCell,
} from "../lib/sheets-client.js";
import { scoreOpportunity } from "../lib/scoring.js";

/**
 * Column layout: A-O
 * A: Opportunity, B: Agency, C: Portal, D: State, E: Deadline,
 * F: Est. Value, G: Score, H: MPA Fit, I: ROI, J: Go/No-Go,
 * K: Reasons, L: URL, M: Status, N: Found Date, O: Last Updated
 */
const COLUMNS = [
  "Opportunity", "Agency", "Portal", "State", "Deadline",
  "Est. Value", "Score", "MPA Fit", "ROI", "Go/No-Go",
  "Reasons", "URL", "Status", "Found Date", "Last Updated",
];

const today = () => new Date().toISOString().split("T")[0];

/**
 * Build a row array from an opportunity + scoring result.
 */
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

/**
 * Normalize an opportunity title for dedup matching.
 * Strips common noise, lowercases, trims.
 */
function normalizeTitle(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check if two opportunities match (dedup).
 * Match on: normalized title + agency (primary), or URL match.
 */
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

  // URL match (if both have URLs)
  if (existingUrl && newUrl && existingUrl === newUrl) {
    return true;
  }

  // Fuzzy title match — check if one contains the other (for slight variations)
  if (existingTitle && newTitle && existingTitle.length > 10 && newTitle.length > 10) {
    if (existingTitle.includes(newTitle) || newTitle.includes(existingTitle)) {
      // Also check agency loosely
      if (!existingAgency || !newAgency || existingAgency.includes(newAgency) || newAgency.includes(existingAgency)) {
        return true;
      }
    }
  }

  return false;
}

export function registerSheetsTools(server) {
  // ---- push_to_sheet: Score + dedup + upsert opportunities ----
  server.tool(
    "push_to_sheet",
    "Score, deduplicate, and push procurement opportunities to the MPA Google Sheet. Accepts an array of opportunities, scores each with the go/no-go engine, deduplicates against existing sheet data, upserts new/updated rows, and applies formatting. Returns a summary of what was added/updated/skipped.",
    {
      opportunities: z.array(
        z.object({
          title: z.string().describe("Opportunity title or solicitation number"),
          agency: z.string().describe("Issuing organization"),
          portal: z.string().describe("Source portal (SAM.gov, DemandStar, etc.)"),
          state: z.string().optional().describe("State (FL preferred)"),
          deadline: z.string().optional().describe("Response due date"),
          estValue: z.string().optional().describe("Estimated dollar value"),
          url: z.string().optional().describe("Direct link to opportunity"),
          description: z.string().optional().describe("Brief description for better scoring"),
          contractType: z.string().optional().describe("multi-year, one-time, recurring, etc."),
          competition: z.string().optional().describe("small-business, limited, open, incumbent"),
          complexity: z.string().optional().describe("low, medium, high"),
        })
      ).describe("Array of procurement opportunities to push"),
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
        return {
          content: [{
            type: "text",
            text: `Error reading sheet: ${err.message}\n\nMake sure:\n1. GOOGLE_SHEETS_CREDS_PATH points to a valid service account JSON\n2. PROCUREMENT_SHEET_ID is set\n3. The service account has editor access to the sheet`,
          }],
        };
      }

      // If sheet is empty, add headers first
      if (existing.length === 0) {
        if (!dry_run) {
          await appendRows([COLUMNS]);
        }
        existing = [COLUMNS];
      }

      const dataRows = existing.slice(1); // skip header
      const results = { added: [], updated: [], skipped: [], errors: [] };

      for (const opp of opportunities) {
        try {
          // 2. Score
          const scoring = scoreOpportunity(opp);
          const row = buildRow(opp, scoring);

          // 3. Dedup check
          let dupeIndex = -1;
          for (let i = 0; i < dataRows.length; i++) {
            if (isDuplicate(opp, dataRows[i])) {
              dupeIndex = i;
              break;
            }
          }

          if (dupeIndex >= 0 && !force_update) {
            results.skipped.push({
              title: opp.title,
              reason: `Duplicate of row ${dupeIndex + 2}`,
              score: scoring.score,
              decision: scoring.decision,
            });
            continue;
          }

          if (dry_run) {
            if (dupeIndex >= 0) {
              results.updated.push({ title: opp.title, row: dupeIndex + 2, score: scoring.score, decision: scoring.decision });
            } else {
              results.added.push({ title: opp.title, score: scoring.score, decision: scoring.decision });
            }
            continue;
          }

          // 4. Upsert
          if (dupeIndex >= 0 && force_update) {
            // Update existing row (keep Status from existing, update everything else)
            const existingStatus = dataRows[dupeIndex][12] || "NEW";
            row[12] = existingStatus; // preserve Status
            row[13] = dataRows[dupeIndex][13] || today(); // preserve Found Date
            row[14] = today(); // update Last Updated

            const rowNum = dupeIndex + 2; // +1 header, +1 for 1-indexed
            await updateRange(`A${rowNum}:O${rowNum}`, [row]);
            await colorGoNoGoCell(rowNum - 1, scoring.decision);
            await colorScoreCell(rowNum - 1, scoring.score);
            results.updated.push({ title: opp.title, row: rowNum, score: scoring.score, decision: scoring.decision });
          } else {
            // Append new row
            await appendRows([row]);
            const newRowNum = existing.length + results.added.length; // 0-indexed for formatting
            await colorGoNoGoCell(newRowNum, scoring.decision);
            await colorScoreCell(newRowNum, scoring.score);
            results.added.push({ title: opp.title, score: scoring.score, decision: scoring.decision });
          }
        } catch (err) {
          results.errors.push({ title: opp.title, error: err.message });
        }
      }

      // 5. Format new rows if any were added
      if (results.added.length > 0 && !dry_run) {
        const startRow = existing.length;
        const endRow = startRow + results.added.length;
        try {
          await formatNewRows(startRow, endRow);
        } catch {
          // Non-fatal — formatting is cosmetic
        }
      }

      // 6. Build summary
      const bidCount = [...results.added, ...results.updated].filter((r) => r.decision === "BID").length;
      const reviewCount = [...results.added, ...results.updated].filter((r) => r.decision === "REVIEW").length;

      let summary = `## push_to_sheet Results${dry_run ? " (DRY RUN)" : ""}\n\n`;
      summary += `**Processed:** ${opportunities.length} opportunities\n`;
      summary += `**Added:** ${results.added.length} | **Updated:** ${results.updated.length} | **Skipped (dupe):** ${results.skipped.length} | **Errors:** ${results.errors.length}\n`;
      summary += `**BID recs:** ${bidCount} | **REVIEW:** ${reviewCount}\n\n`;

      if (results.added.length > 0) {
        summary += "**New:**\n";
        for (const r of results.added) {
          summary += `  [${r.decision}] ${r.score}/100 — ${r.title}\n`;
        }
        summary += "\n";
      }

      if (results.updated.length > 0) {
        summary += "**Updated:**\n";
        for (const r of results.updated) {
          summary += `  [${r.decision}] ${r.score}/100 — ${r.title} (row ${r.row})\n`;
        }
        summary += "\n";
      }

      if (results.skipped.length > 0) {
        summary += "**Skipped (duplicates):**\n";
        for (const r of results.skipped) {
          summary += `  ${r.title} — ${r.reason}\n`;
        }
        summary += "\n";
      }

      if (results.errors.length > 0) {
        summary += "**Errors:**\n";
        for (const r of results.errors) {
          summary += `  ${r.title} — ${r.error}\n`;
        }
      }

      return { content: [{ type: "text", text: summary }] };
    }
  );

  // ---- rescore_sheet: Re-score all existing opportunities ----
  server.tool(
    "rescore_sheet",
    "Re-read and re-score all opportunities currently in the Google Sheet. Useful after tweaking scoring logic. Updates Score, MPA Fit, ROI, Go/No-Go, Reasons, and Last Updated for every row.",
    {
      confirm: z.boolean().describe("Set to true to confirm. This overwrites scoring columns for ALL rows."),
    },
    async (params) => {
      if (!params.confirm) {
        return { content: [{ type: "text", text: "Set confirm=true to re-score all rows. This will overwrite columns G-K and O." }] };
      }

      const existing = await readRange("A:O");
      if (existing.length <= 1) {
        return { content: [{ type: "text", text: "Sheet is empty or has only headers." }] };
      }

      const dataRows = existing.slice(1);
      let updated = 0;

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

        // Update G-K (Score through Reasons) and O (Last Updated)
        await updateRange(`G${rowNum}:K${rowNum}`, [[
          String(scoring.score),
          scoring.mpaFit,
          scoring.roi,
          scoring.decision,
          scoring.reasons,
        ]]);
        await updateRange(`O${rowNum}`, [[today()]]);
        await colorGoNoGoCell(rowNum - 1, scoring.decision);
        await colorScoreCell(rowNum - 1, scoring.score);
        updated++;
      }

      return {
        content: [{
          type: "text",
          text: `Re-scored ${updated} opportunities. All scoring columns (G-K) and Last Updated (O) have been refreshed.`,
        }],
      };
    }
  );

  // ---- sheet_status: Quick pipeline status ----
  server.tool(
    "sheet_status",
    "Get a quick status summary of the MPA procurement pipeline — counts by decision, status, and top opportunities.",
    {},
    async () => {
      const existing = await readRange("A:O");
      if (existing.length <= 1) {
        return { content: [{ type: "text", text: "Pipeline is empty." }] };
      }

      const rows = existing.slice(1);
      const total = rows.length;

      // Count by decision (col J = index 9)
      const decisions = { BID: 0, REVIEW: 0, SKIP: 0 };
      for (const row of rows) {
        const d = (row[9] || "").toUpperCase();
        if (decisions[d] !== undefined) decisions[d]++;
      }

      // Count by status (col M = index 12)
      const statuses = {};
      for (const row of rows) {
        const s = row[12] || "UNKNOWN";
        statuses[s] = (statuses[s] || 0) + 1;
      }

      // Top 5 by score
      const scored = rows
        .map((r, i) => ({ title: r[0], score: parseInt(r[6]) || 0, decision: r[9], row: i + 2 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      let text = `## MPA Procurement Pipeline Status\n\n`;
      text += `**Total opportunities:** ${total}\n`;
      text += `**BID:** ${decisions.BID} | **REVIEW:** ${decisions.REVIEW} | **SKIP:** ${decisions.SKIP}\n\n`;
      text += `**By status:**\n`;
      for (const [s, c] of Object.entries(statuses).sort((a, b) => b[1] - a[1])) {
        text += `  ${s}: ${c}\n`;
      }
      text += `\n**Top 5 opportunities:**\n`;
      for (const o of scored) {
        text += `  [${o.decision}] ${o.score}/100 — ${o.title}\n`;
      }

      return { content: [{ type: "text", text }] };
    }
  );
}
