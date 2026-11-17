import { mkdirSync } from "fs";
import { dirname, join } from "path";

/**
 * Where the demo keeps its keys, deployment and runtime state (PXE stores, the
 * SQLite store, the reference secret): $DATA_DIR, or packages/demo/.data, which
 * git ignores. Never under src/, so a run cannot leave state among the sources.
 */
export const DATA_DIR = process.env.DATA_DIR ?? join(dirname(new URL(import.meta.url).pathname), "../../.data");
mkdirSync(DATA_DIR, { recursive: true });
