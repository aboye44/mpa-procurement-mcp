/**
 * Google Sheets API Client — Direct API with service account auth.
 * ~200-400ms per call vs 1.5-5.7s through Pipedream connector.
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
      "GOOGLE_SHEETS_CREDS_PATH not set. Point it at your service account JSON key file."
    );
  }
  if (!PROCUREMENT_SHEET_ID) {
    throw new Error(
      "PROCUREMENT_SHEET_ID not set. Set it to the Google Sheet ID."
    );
  }

  const creds = JSON.parse(readFileSync(GOOGLE_SHEETS_CREDS_PATH, "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  _sheets = google.sheets({ version: "v4", auth });
  return _sheets;
}

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
 * Execute a batchUpdate request (formatting, conditional formatting, etc.).
 * @param {object[]} requests - Array of Sheets API request objects
 */
export async function batchUpdate(requests) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: PROCUREMENT_SHEET_ID,
    resource: { requests },
  });
  return res.data;
}

/**
 * Apply standard MPA formatting to newly added rows.
 * - Conditional coloring on Go/No-Go column (J)
 * - Score column coloring (G)
 * - Alternating row shading
 * @param {number} startRow - 0-indexed row number where new data starts
 * @param {number} endRow - 0-indexed row number where new data ends (exclusive)
 * @param {number} sheetId - Worksheet ID (default 0 = first sheet)
 */
export async function formatNewRows(startRow, endRow, sheetId = 0) {
  const requests = [];

  // Light gray background for all new data cells
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

  // Center-align columns G-J and N-O
  const centerCols = [
    [6, 10],  // G-J (Score, MPA Fit, ROI, Go/No-Go)
    [13, 15], // N-O (Found Date, Last Updated)
  ];
  for (const [start, end] of centerCols) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: start, endColumnIndex: end },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: "CENTER",
          },
        },
        fields: "userEnteredFormat.horizontalAlignment",
      },
    });
  }

  if (requests.length > 0) {
    await batchUpdate(requests);
  }
}

/**
 * Color a specific cell based on Go/No-Go value.
 * BID = green, REVIEW = amber, SKIP = red
 * @param {number} row - 0-indexed row
 * @param {string} decision - BID, REVIEW, or SKIP
 * @param {number} sheetId - Worksheet ID (default 0)
 */
export async function colorGoNoGoCell(row, decision, sheetId = 0) {
  const colors = {
    BID: { red: 0.85, green: 0.93, blue: 0.83 },     // light green
    REVIEW: { red: 1.0, green: 0.95, blue: 0.8 },     // light amber
    SKIP: { red: 0.96, green: 0.8, blue: 0.8 },        // light red
  };
  const textColors = {
    BID: { red: 0.15, green: 0.5, blue: 0.15 },
    REVIEW: { red: 0.6, green: 0.4, blue: 0.0 },
    SKIP: { red: 0.6, green: 0.15, blue: 0.15 },
  };
  const bg = colors[decision] || colors.SKIP;
  const fg = textColors[decision] || textColors.SKIP;

  await batchUpdate([
    {
      repeatCell: {
        range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 9, endColumnIndex: 10 },
        cell: {
          userEnteredFormat: {
            backgroundColor: bg,
            textFormat: { bold: true, foregroundColor: fg },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
  ]);
}

/**
 * Color the Score cell (column G) based on value.
 * 75+ = green, 50-74 = amber, <50 = red
 * @param {number} row - 0-indexed row
 * @param {number} score - Score value 0-100
 * @param {number} sheetId - Worksheet ID (default 0)
 */
export async function colorScoreCell(row, score, sheetId = 0) {
  let bg, fg;
  if (score >= 75) {
    bg = { red: 0.85, green: 0.93, blue: 0.83 };
    fg = { red: 0.15, green: 0.5, blue: 0.15 };
  } else if (score >= 50) {
    bg = { red: 1.0, green: 0.95, blue: 0.8 };
    fg = { red: 0.6, green: 0.4, blue: 0.0 };
  } else {
    bg = { red: 0.96, green: 0.8, blue: 0.8 };
    fg = { red: 0.6, green: 0.15, blue: 0.15 };
  }

  await batchUpdate([
    {
      repeatCell: {
        range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 6, endColumnIndex: 7 },
        cell: {
          userEnteredFormat: {
            backgroundColor: bg,
            textFormat: { bold: true, foregroundColor: fg },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
  ]);
}
