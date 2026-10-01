/**
 * Local HTTP server for the funding page.
 *
 * Binds to 127.0.0.1 on a random port by default. Every API call must carry
 * the per-run token from the page URL, so other sites open in the same
 * browser cannot drive it. The server never sends the claim secret anywhere.
 */
import { createServer, type IncomingMessage, type Server } from "http";
import { renderFundPage } from "./page.js";

export interface FundApi {
  state(): Promise<unknown>;
  prepare(owner: string): Promise<unknown>;
  submitted(body: { l1TxHash: string; owner: string }): Promise<unknown>;
}

export interface FundServer {
  url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 16 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (typeof parsed !== "object" || parsed === null) throw new Error("Expected a JSON object");
  return Object.fromEntries(Object.entries(parsed));
}

function hexField(body: Record<string, unknown>, key: string, bytes: number): string {
  const value = body[key];
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error(`"${key}" must be a ${bytes}-byte hex string`);
  }
  return value;
}

export async function startFundServer(
  api: FundApi,
  opts: { host?: string; port?: number },
): Promise<FundServer> {
  const token = crypto.randomUUID();
  const host = opts.host ?? "127.0.0.1";

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(type === "application/json" ? JSON.stringify(body) : String(body));
    };
    if (url.searchParams.get("t") !== token) return send(403, { error: "bad or missing token" });

    try {
      if (req.method === "GET" && url.pathname === "/") {
        return send(200, renderFundPage(token), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        return send(200, await api.state());
      }
      if (req.method === "POST" && url.pathname === "/api/prepare") {
        const body = await readJson(req);
        return send(200, await api.prepare(hexField(body, "owner", 20)));
      }
      if (req.method === "POST" && url.pathname === "/api/submitted") {
        const body = await readJson(req);
        return send(
          200,
          await api.submitted({ l1TxHash: hexField(body, "l1TxHash", 32), owner: hexField(body, "owner", 20) }),
        );
      }
      return send(404, { error: "not found" });
    } catch (error) {
      return send(400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Funding server has no TCP address");
  const { port } = address;
  const shownHost = host === "0.0.0.0" ? "localhost" : host;
  return {
    url: `http://${shownHost}:${port}/?t=${token}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
