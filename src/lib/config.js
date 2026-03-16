import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");

// Load .env from project root
config({ path: resolve(PROJECT_ROOT, ".env") });

// MPA target NAICS codes
export const NAICS_CODES = [
  "323111", // Commercial Printing (except Screen and Books)
  "323120", // Support Activities for Printing
  "561431", // Private Mail Centers / Mailing Services
  "561410", // Document Preparation Services
  "323110", // Commercial Lithographic Printing
  "541860", // Direct Mail Advertising
];

// MPA target PSC codes
export const PSC_CODES = ["S222", "S299"];

// Search keywords
export const KEYWORDS = [
  "printing",
  "mail services",
  "direct mail",
  "mailing",
  "EDDM",
  "presort",
  "fulfillment",
  "print and mail",
  "mailroom",
  "utility billing",
];

// Portal-specific keywords for browser searches
export const PORTAL_KEYWORDS = [
  "mail",
  "printing",
  "mailing",
  "courier",
  "mailroom",
  "statement printing",
  "utility billing",
];

// Data directory
const DATA_DIR = resolve(PROJECT_ROOT, "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

export const FEED_PATH =
  process.env.FEED_PATH || resolve(DATA_DIR, "procurement_feed.json");
export const DB_PATH =
  process.env.DB_PATH || resolve(DATA_DIR, "tracker.db");
export const SAM_API_KEY = process.env.SAM_GOV_API_KEY;
export const BIDNET_EMAIL = process.env.BIDNET_EMAIL;
export const BIDNET_PASSWORD = process.env.BIDNET_PASSWORD;
export const MFMP_EMAIL = process.env.MFMP_EMAIL;
export const MFMP_PASSWORD = process.env.MFMP_PASSWORD;
export const BONFIRE_EMAIL = process.env.BONFIRE_EMAIL;
export const BONFIRE_PASSWORD = process.env.BONFIRE_PASSWORD;
export const GPO_EMAIL = process.env.GPO_EMAIL;
export const GPO_PASSWORD = process.env.GPO_PASSWORD;
export const BIDSYNC_EMAIL = process.env.BIDSYNC_EMAIL;
export const BIDSYNC_PASSWORD = process.env.BIDSYNC_PASSWORD;
export const USPS_COUPA_EMAIL = process.env.USPS_COUPA_EMAIL;
export const USPS_COUPA_PASSWORD = process.env.USPS_COUPA_PASSWORD;

// Google Sheets API (direct — service account auth)
export const GOOGLE_SHEETS_CREDS_PATH = process.env.GOOGLE_SHEETS_CREDS_PATH;
export const PROCUREMENT_SHEET_ID = process.env.PROCUREMENT_SHEET_ID || "1ze-9C0g924sotn3emm5j7N_jtw-MvRiBWDrh1T1tJa8";
