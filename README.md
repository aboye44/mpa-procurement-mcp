# MPA Procurement MCP Server

Unified MCP server for MPA's procurement intelligence pipeline. Replaces 7 Perplexity Computer cron jobs with a single local MCP server running in Claude Code.

## 30+ Tools Across 12 Portals

### Core Portals (API + Browser)

| Tool | Portal | Description |
|------|--------|-------------|
| `sam_search` | SAM.gov | Search federal opportunities by keyword, NAICS, state, etc. |
| `sam_entity_search` | SAM.gov | Look up registered vendors by name, UEI, CAGE, NAICS |
| `sam_mpa_scan` | SAM.gov | MPA-optimized scan across 6 NAICS codes + 10 keywords |
| `demandstar_scan` | DemandStar | Florida print/mail procurement search |
| `mfmp_scan` | MFMP | MyFloridaMarketPlace Angular SPA search |
| `bonfire_scan` | Bonfire | Bonfire/Euna portal search + dashboard check |
| `bidnet_scan` | BidNet | BidNet Direct search + org matching profile |
| `gpo_small_purchases` | GPO Publish | Fetch open small purchase opportunities (≤$100K) via public API |
| `gpo_term_bids` | GPO Publish | Term contract & one-time bid listings from gpo.gov |
| `gpo_mpa_scan` | GPO Publish | Combined GPO sweep with MPA relevance scoring |
| `gpo_job_detail` | GPO Publish | Get specs for a specific GPO job by jacket number |
| `gpo_award_results` | GPO Publish | Search past award results for competitive intel (auth required) |

### New Portals (v2.0)

| Tool | Portal | Description |
|------|--------|-------------|
| `bidsync_scan` | BidSync/Periscope S2G | Largest gov-bid database in NA. Covers 50+ FL agencies (Miami-Dade, Broward, Palm Beach, etc.) |
| `bidsync_agency_list` | BidSync/Periscope S2G | List all 50+ FL agencies tracked on BidSync with portal URLs |
| `opengov_scan` | OpenGov | 24 FL agencies using OpenGov procurement (Pinellas, Orange, St. Pete, Clearwater, Lakeland, etc.) |
| `opengov_agency_list` | OpenGov | List all FL agencies tracked on OpenGov with portal URLs |
| `ionwave_scan` | IonWave | 20 FL cities using IonWave eProcurement (Lauderhill, Lee County, Cape Coral, etc.) |
| `ionwave_agency_list` | IonWave | List all FL agencies tracked on IonWave with portal URLs |
| `fl_county_scan` | FL County Direct | 12 FL county procurement websites (Polk, Hillsborough, Pinellas, Orange, Duval, etc.) |
| `fl_county_list` | FL County Direct | List all FL county procurement portals with direct URLs |
| `fl_vbs_scan` | FL VBS | Florida Vendor Bid System — ALL FL state agency solicitations + CBI dashboard matches |
| `usps_scan` | USPS | USPS solicitations page + Coupa Supplier Portal sourcing events |

### Aggregator & Tracker

| Tool | Description |
|------|-------------|
| `full_procurement_scan` | One-command scan of ALL 12 portals with scoring. Supports `quick_scan` mode to skip slower portals. |
| `list_tracked` | View all tracked opportunities with filters |
| `dismiss_opportunity` | Mark an opportunity as dismissed |
| `scan_history` | View scan run history |
| `export_feed` | Export feed JSON for Command Center |

## Portal Coverage Map

```
Federal:     SAM.gov, GPO Publish, USPS
State:       MFMP, FL VBS
Aggregators: DemandStar, BidSync/Periscope S2G, BidNet, Bonfire, OpenGov, IonWave
County:      Polk, Hillsborough, Pinellas, Orange, Duval, Volusia, Brevard,
             Seminole, Osceola, Pasco, Sarasota, Manatee
Cities:      50+ BidSync agencies, 24 OpenGov agencies, 20 IonWave agencies
```

**Total unique FL agencies covered: 100+**

## Setup

### 1. Clone and install

```bash
git clone https://github.com/aboye44/mpa-procurement-mcp.git
cd mpa-procurement-mcp
npm install
npx playwright install chromium
```

### 2. Configure credentials

```bash
cp .env.example .env
# Edit .env with your credentials
```

**Required:** SAM.gov API key
**Recommended:** GPO, BidNet, Bonfire, MFMP credentials for full coverage
**Optional:** BidSync ($109/mo FL plan for full search), USPS Coupa (requires registration)
**Free (no credentials):** DemandStar, OpenGov, IonWave, FL Counties, FL VBS public search

### 3. Add to Claude Code

```bash
claude mcp add mpa-procurement node C:\path\to\mpa-procurement-mcp\src\index.js
```

Note: Claude Code inherits your shell environment, so `.env` is loaded by the server automatically.

### 4. Schedule scans

In Claude Code, set up a recurring task:

```
/task add "Run full MPA procurement scan" --schedule "weekdays 7:30am, 1:30pm"
```

Or use the CLI directly:

```bash
# Full scan (all 12 portals)
node src/cli-scan.js

# Quick scan (skip BidSync, IonWave, FL Counties — faster)
node src/cli-scan.js --quick

# SAM.gov only (fast, API-based)
node src/cli-scan.js --sam-only

# Browser portals only
node src/cli-scan.js --portals-only

# Custom lookback
node src/cli-scan.js --days 30
```

## Architecture

```
src/
  index.js           # MCP server entry point (v2.0)
  cli-scan.js        # CLI for scheduled runs
  lib/
    config.js        # Env vars, NAICS codes, keywords
    db.js            # JSON-based tracker (no SQLite dependency)
    browser.js       # Shared Playwright browser management
    scorer.js        # Opportunity relevance scoring
  tools/
    sam-gov.js       # SAM.gov API tools (3 tools)
    demandstar.js    # DemandStar browser tool (1 tool)
    mfmp.js          # MFMP browser tool (1 tool)
    bonfire.js       # Bonfire browser tool (1 tool)
    bidnet.js        # BidNet browser tool (1 tool)
    gpo.js           # GPO Publish API + browser tools (5 tools)
    bidsync.js       # BidSync/Periscope S2G browser tools (2 tools)
    opengov.js       # OpenGov Procurement browser tools (2 tools)
    ionwave.js       # IonWave eProcurement browser tools (2 tools)
    fl-counties.js   # FL County direct portal tools (2 tools)
    fl-vbs.js        # FL Vendor Bid System browser tool (1 tool)
    usps.js          # USPS eSourcing browser tool (1 tool)
    aggregator.js    # Full scan + tracker management tools (5 tools)
data/                # Auto-created, gitignored
  tracker.json       # Opportunity tracker state
  procurement_feed.json  # Exported feed for Command Center
```

## Credit Savings

Previously: 7 Computer crons × 2 runs/day × 5 weekdays = **70 sessions/week**

Now: Local MCP server, **0 Computer credits**.

## License

MIT
