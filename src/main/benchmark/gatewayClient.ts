import { app } from 'electron';
import { BenchmarkDefaults } from '../../benchmark/constants';
import type { OpenClawEngineManager } from '../libs/openclawEngineManager';

export type GatewayEventFrame = {
  event: string;
  seq?: number;
  payload?: unknown;
};

type GatewayClientLike = {
  request<T>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  start(): void;
  stop(): void;
};

export interface BenchmarkGatewayClientDeps {
  getOpenClawEngineManager: () => OpenClawEngineManager;
  onEvent: (event: GatewayEventFrame) => void;
}

async function loadGatewayClientCtor(clientEntryPath: string): Promise<new (options: Record<string, unknown>) => GatewayClientLike> {
  const loaded = require(clientEntryPath) as Record<string, unknown>;
  const direct = loaded.GatewayClient;
  if (typeof direct === 'function') {
    return direct as unknown as new (options: Record<string, unknown>) => GatewayClientLike;
  }
  for (const candidate of Object.values(loaded)) {
    if (typeof candidate !== 'function') continue;
    const maybeCtor = candidate as { prototype?: { start?: unknown; stop?: unknown; request?: unknown } };
    const proto = maybeCtor.prototype;
    if (proto
      && typeof proto.start === 'function'
      && typeof proto.stop === 'function'
      && typeof proto.request === 'function') {
      return candidate as unknown as new (options: Record<string, unknown>) => GatewayClientLike;
    }
  }
  throw new Error(`Invalid OpenClaw gateway client module: ${clientEntryPath}`);
}

/**
 * A minimal OpenClaw gateway client for benchmark runs. Mirrors the wiring in
 * OpenClawRuntimeAdapter.createGatewayClient but without any Cowork coupling.
 * Events are forwarded to the provided onEvent handler; requests are only
 * allowed after the connect handshake completes.
 */
export class BenchmarkGatewayClient {
  private client: GatewayClientLike | null = null;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;

  constructor(private deps: BenchmarkGatewayClientDeps) {}

  async ensureReady(): Promise<void> {
    if (this.client) return;

    const engine = this.deps.getOpenClawEngineManager();
    const status = await engine.startGateway('benchmark-run');
    if (status.phase !== 'running') {
      throw new Error(status.message || 'OpenClaw 引擎未运行');
    }
    const connection = engine.getGatewayConnectionInfo();
    const missing: string[] = [];
    if (!connection.url) missing.push('url');
    if (!connection.token) missing.push('token');
    if (!connection.clientEntryPath) missing.push('clientEntryPath');
    if (missing.length > 0) {
      throw new Error(`OpenClaw 网关连接信息不完整 (missing: ${missing.join(', ')})`);
    }

    const GatewayClient = await loadGatewayClientCtor(connection.clientEntryPath);
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    const client = new GatewayClient({
      url: connection.url,
      token: connection.token,
      clientDisplayName: 'LobsterAI-Benchmark',
      clientVersion: app.getVersion(),
      mode: 'backend',
      caps: ['tool-events'],
      role: 'operator',
      scopes: ['operator.admin'],
      onHelloOk: () => {
        this.client = client;
        this.resolveReady?.();
      },
      onConnectError: (error: Error) => {
        const msg = error?.message?.toLowerCase() ?? '';
        const isAuthFailure = msg.includes('auth') || msg.includes('denied') || msg.includes('forbidden');
        if (isAuthFailure) this.rejectReady?.(error);
      },
      onClose: () => {
        // The GatewayClient auto-reconnects; transient closes are tolerated.
      },
      onEvent: (event: GatewayEventFrame) => this.deps.onEvent(event),
    });

    client.start();
    await Promise.race([
      this.readyPromise,
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`OpenClaw 网关握手超时（${BenchmarkDefaults.gatewayReadyTimeoutMs}ms）`)), BenchmarkDefaults.gatewayReadyTimeoutMs);
      }),
    ]);
  }

  async request<T>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    if (!this.client) throw new Error('OpenClaw 网关客户端未就绪');
    return this.client.request<T>(method, params, opts);
  }

  async stop(): Promise<void> {
    try {
      this.client?.stop();
    } catch {
      // ignore
    }
    this.client = null;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
  }
}
