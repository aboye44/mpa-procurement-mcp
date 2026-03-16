#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSamGovTools } from "./tools/sam-gov.js";
import { registerDemandStarTools } from "./tools/demandstar.js";
import { registerMFMPTools } from "./tools/mfmp.js";
import { registerBonfireTools } from "./tools/bonfire.js";
import { registerBidNetTools } from "./tools/bidnet.js";
import { registerGPOTools } from "./tools/gpo.js";
import { registerBidSyncTools } from "./tools/bidsync.js";
import { registerOpenGovTools } from "./tools/opengov.js";
import { registerIonWaveTools } from "./tools/ionwave.js";
import { registerFLCountyTools } from "./tools/fl-counties.js";
import { registerFLVBSTools } from "./tools/fl-vbs.js";
import { registerUSPSTools } from "./tools/usps.js";
import { registerAggregatorTools } from "./tools/aggregator.js";
import { registerSheetsTools } from "./tools/sheets.js";

const server = new McpServer({
  name: "mpa-procurement",
  version: "2.0.0",
  description: "MPA Procurement Intelligence — 12 portals, 30+ tools. SAM.gov, DemandStar, MFMP, Bonfire, BidNet, GPO Publish, BidSync/Periscope S2G, OpenGov, IonWave, FL County Direct, FL VBS, USPS.",
});

// Register all tools
registerSamGovTools(server);
registerDemandStarTools(server);
registerMFMPTools(server);
registerBonfireTools(server);
registerBidNetTools(server);
registerGPOTools(server);
registerBidSyncTools(server);
registerOpenGovTools(server);
registerIonWaveTools(server);
registerFLCountyTools(server);
registerFLVBSTools(server);
registerUSPSTools(server);
registerAggregatorTools(server);
registerSheetsTools(server);

// Start
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MPA Procurement MCP Server v2.0 running (30+ tools across 12 portals + aggregator)");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
