/**
 * Google Sheets API Client — Direct API with service account auth.
 * ~200-400ms per call vs 1.5-5.7s through Pipedream connector.
 *
 * v2.1: Added batchValueUpdate for bulk writes (102 calls → 2 calls).
 */
import { google } from "googleapis";
import { readFileSync } from "fs";
import { GOOGLE_SHEETS_CREDS_PATH, PROCUREMENT_SHEET_ID } from "./config.js";

let _sheets = null;

/**
 * Get authenticated Sheets API client (singleton).
 * Uses service account JSON key file for auth.
 */
function getClient() {
  if (_sheets) return _sheets;

  if (!GOOGLE_SHEETS_CREDS_PATH) {
    throw new Error(
      "GOOGLE_SHEETS_CREDS_PATH not set. " +
      "Point it at your service account JSON key file. " +
      "See SETUP.md Step 5 for instructions."
    );
  }
  if (!PROCUREMENT_SHEET_ID) {
    throw new Error(
      "PROCUREMENT_SHEET_ID not set. " +
      "Add PROCUREMENT_SHEET_ID=1ze-9C0g924sotn3emm5j7N_jtw-MvRiBWDrh1T1tJa8 to your .env file."
    );
  }

  let creds;
  try {
    creds = JSON.parse(readFileSync(GOOGLE_SHEETS_CREDS_PATH, "utf8"));
  } catch (err) {
    throw new Error(
      `Cannot read service account key at "${GOOGLE_SHEETS_CREDS_PATH}": ${err.message}. ` +
      "Download a new key from Google Cloud Console → IAM → Service Accounts → Keys tab."
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  _sheets = google.sheets({ version: "v4", auth });
  return _sheets;
}

// ---- Color constants (shared across formatting functions) ----
const COLORS = {
  BID:    { bg: { red: 0.85, green: 0.93, blue: 0.83 }, fg: { red: 0.15, green: 0.5, blue: 0.15 } },
  REVIEW: { bg: { red: 1.0, green: 0.95, blue: 0.8 },  fg: { red: 0.6, green: 0.4, blue: 0.0 } },
  SKIP:   { bg: { red: 0.96, green: 0.8, blue: 0.8 },  fg: { red: 0.6, green: 0.15, blue: 0.15 } },
};

function scoreColor(score) {
  if (score >= 75) return COLORS.BID;
  if (score >= 50) return COLORS.REVIEW;
  return COLORS.SKIP;
}

// ---- Core API functions ----

/**
 * Read all values from a range. Returns 2D array of strings.
 * @param {string} range - A1 notation, e.g. "Sheet1!A:O" or "A:O"
 */
export async function readRange(range) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PROCUREMENT_SHEET_ID,
    range,
  });
  return res.data.values || [];
}

/**
 * Append rows after the last row with data.
 * @param {string[][]} rows - Array of row arrays
 * @param {string} range - Target range, e.g. "A:O"
 */
export async function appendRows(rows, range = "A:O") {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: PROCUREMENT_SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values: rows },
  });
  return res.data.updates;
}

/**
 * Update a specific range (for upsert — overwrite existing row).
 * @param {string} range - Exact range, e.g. "A5:O5"
 * @param {string[][]} values - Row data
 */
export async function updateRange(range, values) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId: PROCUREMENT_SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });
  return res.data;
}

/**
 * Batch update multiple value ranges in a single API call.
 * This is the key performance improvement: 102 sequential calls → 1 call.
 * @param {Array<{range: string, values: string[][]}>} updates - Array of range+value pairs
 */
export async function batchValueUpdate(updates) {
  if (!updates.length) return null;
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: PROCUREMENT_SHEET_ID,
    resource: {
      valueInputOption: "USER_ENTERED",
      data: updates,
    },
  });
  return res.data;
}

/**
 * Execute a batchUpdate request (formatting, conditional formatting, etc.).
 * @param {object[]} requests - Array of Sheets API request objects
 */
export async function batchUpdate(requests) {
  if (!requests.length) return null;
  const sheets = getClient();
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: PROCUREMENT_SHEET_ID,
    resource: { requests },
  });
  return res.data;
}

// ---- Formatting helpers (build requests without executing) ----

/**
 * Build formatting requests for a Go/No-Go cell.
 * Returns a request object — does NOT call the API.
 */
export function buildGoNoGoFormat(row, decision, sheetId = 0) {
  const c = COLORS[decision] || COLORS.SKIP;
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 9, endColumnIndex: 10 },
      cell: {
        userEnteredFormat: {
          backgroundColor: c.bg,
          textFormat: { bold: true, foregroundColor: c.fg },
        },
      },
      fields: "userEnteredFormat(backgroundColor,textFormat)",
    },
  };
}

/**
 * Build formatting requests for a Score cell.
 * Returns a request object — does NOT call the API.
 */
export function buildScoreFormat(row, score, sheetId = 0) {
  const c = scoreColor(score);
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 6, endColumnIndex: 7 },
      cell: {
        userEnteredFormat: {
          backgroundColor: c.bg,
          textFormat: { bold: true, foregroundColor: c.fg },
        },
      },
      fields: "userEnteredFormat(backgroundColor,textFormat)",
    },
  };
}

/**
 * Build formatting requests for newly added rows (borders, shading, alignment).
 * Returns an array of request objects — does NOT call the API.
 */
export function buildNewRowFormats(startRow, endRow, sheetId = 0) {
  const requests = [];

  // Borders + font for all new cells
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: 0, endColumnIndex: 15 },
      cell: {
        userEnteredFormat: {
          borders: {
            bottom: { style: "SOLID", width: 1, color: { red: 0.85, green: 0.85, blue: 0.85 } },
          },
          textFormat: { fontSize: 10 },
        },
      },
      fields: "userEnteredFormat(borders,textFormat)",
    },
  });

  // Alternating row shading
  for (let row = startRow; row < endRow; row++) {
    if (row % 2 === 0) {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 15 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.96, green: 0.96, blue: 0.96 },
            },
          },
          fields: "userEnteredFormat.backgroundColor",
        },
      });
    }
  }

  // Center-align G-J and N-O
  for (const [start, end] of [[6, 10], [13, 15]]) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: start, endColumnIndex: end },
        cell: {
          userEnteredFormat: { horizontalAlignment: "CENTER" },
        },
        fields: "userEnteredFormat.horizontalAlignment",
      },
    });
  }

  return requests;
}

// ---- Legacy convenience wrappers (still usable for one-off calls) ----

export async function formatNewRows(startRow, endRow, sheetId = 0) {
  const requests = buildNewRowFormats(startRow, endRow, sheetId);
  if (requests.length) await batchUpdate(requests);
}

export async function colorGoNoGoCell(row, decision, sheetId = 0) {
  await batchUpdate([buildGoNoGoFormat(row, decision, sheetId)]);
}

export async function colorScoreCell(row, score, sheetId = 0) {
  await batchUpdate([buildScoreFormat(row, score, sheetId)]);
}
