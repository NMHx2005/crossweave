import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { CrossweaveError } from '../core/errors.js';

export interface GatewayServerOptions {
  socketPath: string;
  port: number;
  host?: string;
  cert?: string;
  key?: string;
  allowInsecure?: boolean;
}

export function validateGatewayServerOptions(opts: GatewayServerOptions): void {
  const host = opts.host ?? '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!loopback && !opts.cert && !opts.allowInsecure) {
    throw new CrossweaveError('INVALID_ARGUMENTS', `Gateway bound to ${host} without TLS requires --allow-insecure (and logs loudly)`);
  }
  if ((opts.cert && !opts.key) || (!opts.cert && opts.key)) {
    throw new CrossweaveError('INVALID_ARGUMENTS', 'Both --cert and --key are required for TLS');
  }
}

export function createGatewayHttpServer(opts: GatewayServerOptions) {
  validateGatewayServerOptions(opts);
  if (opts.cert && opts.key) {
    const cert = readFileSync(opts.cert, 'utf8');
    const key = readFileSync(opts.key, 'utf8');
    return createHttpsServer({ cert, key });
  }
  const host = opts.host ?? '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!loopback && opts.allowInsecure) {
    process.stderr.write(`crossweave: gateway on ${host} without TLS (--allow-insecure) — tokens travel cleartext!\n`);
  }
  return createHttpServer();
}
