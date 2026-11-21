import { randomBytes, randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "./config.ts";

/**
 * Server MCP in-process (team, browser) yang dibuka lewat Streamable HTTP untuk mesin selain
 * Claude Agent SDK. Definisi tool tetap satu: factory mengembalikan `instance` dari
 * `createSdkMcpServer`, jadi handler, state browser, live view, dan kendali owner tetap
 * hidup di proses ini.
 *
 * Akses: token acak per runner di header `Authorization: Bearer …`, dicabut saat runner ditutup.
 * Route ini dipasang di bawah `/api`, jadi pagar Host/Origin (`httpGuard`) sudah berlaku; permintaan
 * yang membawa Origin (browser) ditolak sekalian — klien MCP lokal tidak pernah mengirimnya.
 */

type Factory = () => McpServer;
type Session = { transport: StreamableHTTPServerTransport; server: McpServer };
type Endpoint = { factories: Record<string, Factory>; sessions: Map<string, Session> };

const endpoints = new Map<string, Endpoint>();

export const MCP_PATH = "/api/internal/mcp";

export type McpEndpoint = {
  token: string;
  servers: Array<{ name: string; url: string }>;
  revoke: () => Promise<void>;
};

/** Alamat server ini untuk klien di mesin yang sama (bind 0.0.0.0 tetap dihubungi lewat loopback). */
export function localBaseUrl(): string {
  const host = CONFIG.host === "0.0.0.0" || CONFIG.host === "::" ? "127.0.0.1" : CONFIG.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${CONFIG.port}`;
}

export function registerMcpEndpoint(factories: Record<string, Factory>): McpEndpoint {
  const token = randomBytes(32).toString("hex");
  const endpoint: Endpoint = { factories, sessions: new Map() };
  endpoints.set(token, endpoint);
  return {
    token,
    servers: Object.keys(factories).map((name) => ({ name, url: `${localBaseUrl()}${MCP_PATH}/${name}` })),
    revoke: async () => {
      endpoints.delete(token);
      const sessions = [...endpoint.sessions.values()];
      endpoint.sessions.clear();
      await Promise.all(
        sessions.map(async ({ transport, server }) => {
          await transport.close().catch(() => undefined);
          await server.close().catch(() => undefined);
        }),
      );
    },
  };
}

export function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

export const mcpRouter = Router();

mcpRouter.all("/internal/mcp/:server", async (req, res) => {
  if (req.headers.origin !== undefined) {
    res.status(403).json({ error: "MCP internal tidak menerima permintaan dari browser" });
    return;
  }
  const token = bearerToken(req);
  const endpoint = token ? endpoints.get(token) : undefined;
  if (!endpoint) {
    res.status(401).json({ error: "token MCP tidak dikenal atau sudah dicabut" });
    return;
  }
  const name = req.params.server;
  const factory = endpoint.factories[name];
  if (!factory) {
    res.status(404).json({ error: `server MCP "${name}" tidak tersedia untuk sesi ini` });
    return;
  }

  const sessionHeader = req.headers["mcp-session-id"];
  const key = (id: string) => `${name}:${id}`;
  let session = typeof sessionHeader === "string" ? endpoint.sessions.get(key(sessionHeader)) : undefined;
  if (!session) {
    if (req.method !== "POST" || !isInitializeRequest(req.body)) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "sesi MCP tidak dikenal" }, id: null });
      return;
    }
    // Satu McpServer hanya bisa terhubung ke satu transport: tiap sesi MCP mendapat instance baru.
    const server = factory();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        endpoint.sessions.set(key(id), { transport, server });
      },
      onsessionclosed: (id) => {
        endpoint.sessions.delete(key(id));
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) endpoint.sessions.delete(key(transport.sessionId));
    };
    await server.connect(transport);
    session = { transport, server };
  }
  try {
    await session.transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: (error as Error).message });
  }
});
