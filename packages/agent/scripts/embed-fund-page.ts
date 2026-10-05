/**
 * Embed the skill's funding page into the CLI (see src/fund/page-source.ts).
 *
 * Usage: bun run scripts/embed-fund-page.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { FUND_PAGE_MODULE, FUND_PAGE_SOURCE, renderModule } from "../src/fund/page-source.js";

writeFileSync(FUND_PAGE_MODULE, renderModule(readFileSync(FUND_PAGE_SOURCE, "utf-8")));
console.error(`Wrote ${FUND_PAGE_MODULE}`);
