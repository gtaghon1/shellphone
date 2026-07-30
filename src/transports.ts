import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer, VERSION } from './server.js';
import { loadConfig } from './paths.js';

/**
 * Two transports, one server (SPEC §3b). stdio is what Claude Code and Claude
 * Desktop use locally — zero setup, no port, no token. HTTP is what claude.ai
 * reaches through a tunnel, and it is the one that needs a credential.
 */

export async function runStdio(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  // stdout belongs to the protocol from here on. Anything we print goes to stderr.
}

function bearerAuth(token: string) {
  const expected = Buffer.from(token);
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.get('authorization') ?? '';
    const presented = Buffer.from(header.replace(/^Bearer\s+/i, ''));
    // Length check first: timingSafeEqual throws on mismatched lengths.
    const ok =
      presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
    if (!ok) {
      res
        .status(401)
        .set('WWW-Authenticate', 'Bearer')
        .json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized: bad or missing bearer token' },
          id: null,
        });
      return;
    }
    next();
  };
}

const methodNotAllowed = (_req: Request, res: Response): void => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed: shellphone runs stateless HTTP' },
    id: null,
  });
};

export interface HttpOptions {
  host?: string;
  port?: number;
}

export async function runHttp(opts: HttpOptions = {}): Promise<void> {
  // Loaded here rather than at module scope: the CLI is on the hot path for
  // every hook fire, and stdio never needs an HTTP server. Also keeps express
  // out of the desktop-extension bundle's startup entirely.
  const { default: express } = await import('express');
  const cfg = loadConfig();
  const host = opts.host ?? cfg.host;
  const port = opts.port ?? cfg.port;

  // The host we are actually bound to always counts as allowed — otherwise
  // `--port` silently 403s every request against a config pinned to another port.
  const allowedHosts = cfg.allowedHosts.length
    ? [...new Set([...cfg.allowedHosts, `${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`])]
    : [];

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Unauthenticated, so a tunnel's health check doesn't need the token.
  // Deliberately says nothing about repos.
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'shellphone', version: VERSION });
  });

  app.use('/mcp', bearerAuth(cfg.token));

  app.post('/mcp', async (req, res) => {
    // Stateless: a fresh server+transport per request. No session table to leak
    // across a tunnel, and a dropped connection costs nothing.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: allowedHosts.length > 0,
      allowedHosts,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[shellphone] request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  await new Promise<void>((resolve, reject) => {
    const srv = app.listen(port, host, () => {
      console.error(`[shellphone] 🦞📞 listening on http://${host}:${port}/mcp`);
      console.error(`[shellphone] bearer token in ~/.shellphone/config.json`);
      if (!allowedHosts.length) {
        console.error('[shellphone] DNS-rebinding protection is OFF (allowedHosts is empty)');
      }
      resolve();
    });
    srv.on('error', reject);
  });
}
