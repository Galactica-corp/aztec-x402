import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Agent skill markdown returned by GET /api/buy-x402-achievement after payment. */
export const X402_ACHIEVEMENT_SKILL = readFileSync(
  join(__dirname, "x402-achievement.md"),
  "utf-8",
);

export const X402_ACHIEVEMENT_CONTENT_TYPE = "text/markdown; charset=utf-8";
