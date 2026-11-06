/**
 * ICE Server Failover Manager
 * Manages STUN/TURN server pools with health checking, failover logic, and adaptive selection.
 * Supports configurable Cloudflare, Twilio, Metered, and Coturn TURN relays for mobile NAT traversal.
 */

export interface IceServerConfig {
  id?: string;
  urls: string[];
  username?: string;
  credential?: string;
  credentialType?: 'password' | 'oauth';
}

export interface HealthCheckResult {
  serverId: string;
  healthy: boolean;
  latency: number;
  error?: string;
  timestamp: number;
}

export interface IceServerMetrics {
  serverId: string;
  successRate: number;
  avgLatency: number;
  lastHealthCheck: number;
  failureCount: number;
  consecutiveFailures: number;
}

const DEFAULT_STUN_SERVERS = [
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:stun1.stunprotocol.org:3478',
  'stun:stun2.stunprotocol.org:3478',
];

const FALLBACK_STUN_SERVERS = [
  'stun:stunserver.stunprotocol.org:3478',
  'stun:stun.services.mozilla.com:3478',
  'stun:stun.ekiga.net:3478',
];

export class IceServerManager {
  private primaryPool: IceServerConfig[] = [];
  private fallbackPool: IceServerConfig[] = [];
  private turnPool: IceServerConfig[] = [];
  private metrics: Map<string, IceServerMetrics> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private healthCheckTimeout = 4000;
  private healthCheckIntervalMs = 60000;
  private maxConsecutiveFailures = 3;

  constructor(customServers?: string[] | IceServerConfig[]) {
    this.initializePools(customServers);
    this.initializeMetrics();
  }

  private initializePools(customServers?: string[] | IceServerConfig[]) {
    // 1. Configure STUN Servers
    if (customServers && customServers.length > 0) {
      if (typeof customServers[0] === 'string') {
        this.primaryPool = (customServers as string[]).map((url, idx) => ({
          id: `custom-stun-${idx}`,
          urls: [url],
        }));
      } else {
        this.primaryPool = customServers as IceServerConfig[];
      }
    } else {
      this.primaryPool = DEFAULT_STUN_SERVERS.map((url, idx) => ({
        id: `primary-stun-${idx}`,
        urls: [url],
      }));
    }

    this.fallbackPool = FALLBACK_STUN_SERVERS.map((url, idx) => ({
      id: `fallback-stun-${idx}`,
      urls: [url],
    }));

    // 2. Discover & Configure TURN Relay if present in environment or runtime
    const metaEnv = typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined;
    const turnUrl = metaEnv?.VITE_TURN_SERVER_URL;
    const turnUser = metaEnv?.VITE_TURN_USERNAME;
    const turnCred = metaEnv?.VITE_TURN_CREDENTIAL;

    if (turnUrl) {
      this.turnPool.push({
        id: 'env-turn-relay',
        urls: turnUrl.split(',').map((u: string) => u.trim()),
        username: turnUser || undefined,
        credential: turnCred || undefined,
      });
    }
  }

  private initializeMetrics() {
    const allServers = [...this.primaryPool, ...this.fallbackPool, ...this.turnPool];
    allServers.forEach((server) => {
      const serverId = server.id || server.urls[0];
      this.metrics.set(serverId, {
        serverId,
        successRate: 100,
        avgLatency: 50,
        lastHealthCheck: 0,
        failureCount: 0,
        consecutiveFailures: 0,
      });
    });
  }

  /**
   * Set dynamic TURN relay credentials (e.g. from backend API or Cloudflare)
   */
  public setTurnRelay(config: IceServerConfig): void {
    const serverId = config.id || 'dynamic-turn-relay';
    this.turnPool = [{ ...config, id: serverId }];
    this.metrics.set(serverId, {
      serverId,
      successRate: 100,
      avgLatency: 80,
      lastHealthCheck: Date.now(),
      failureCount: 0,
      consecutiveFailures: 0,
    });
  }

  /**
   * Get current RTCConfiguration with adaptive server selection and TURN fallback
   */
  public getConfiguration(): RTCConfiguration {
    const stunServers = this.selectServersAdaptively();
    const finalServers: IceServerConfig[] = [...stunServers];

    // Always include TURN relay if configured for symmetric NAT / cellular network traversal
    if (this.turnPool.length > 0) {
      finalServers.push(...this.turnPool);
    }

    return {
      iceServers: finalServers.map((s) => ({
        urls: s.urls,
        username: s.username,
        credential: s.credential,
      })),
      iceCandidatePoolSize: 2,
    };
  }

  /**
   * Adaptively select servers based on accurate server IDs and health metrics
   */
  private selectServersAdaptively(): IceServerConfig[] {
    const allServers = [...this.primaryPool, ...this.fallbackPool];
    const healthyServers = allServers.filter((server) => {
      const serverId = server.id || server.urls[0];
      const metrics = this.metrics.get(serverId);
      if (!metrics) return true;
      return metrics.consecutiveFailures < this.maxConsecutiveFailures;
    });

    if (healthyServers.length === 0) {
      this.metrics.forEach((m) => {
        m.consecutiveFailures = 0;
      });
      return allServers.slice(0, 4);
    }

    // Correctly map scores using each server's own ID
    const scored = healthyServers
      .map((server) => {
        const serverId = server.id || server.urls[0];
        const metrics = this.metrics.get(serverId);
        const score =
          (metrics?.successRate || 100) * 0.7 -
          (metrics?.avgLatency || 50) * 0.3;
        return { server, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, 4).map(({ server }) => server);
  }

  public recordHealthCheck(serverId: string, result: HealthCheckResult): void {
    const metrics = this.metrics.get(serverId);
    if (!metrics) return;

    if (result.healthy) {
      metrics.consecutiveFailures = 0;
      metrics.successRate = Math.min(100, metrics.successRate * 0.9 + 10);
      metrics.avgLatency = metrics.avgLatency * 0.7 + result.latency * 0.3;
    } else {
      metrics.consecutiveFailures++;
      metrics.failureCount++;
      metrics.successRate = Math.max(0, metrics.successRate - 20);
    }

    metrics.lastHealthCheck = result.timestamp;
  }

  public async performHealthChecks(): Promise<HealthCheckResult[]> {
    const allServers = [...this.primaryPool, ...this.fallbackPool];
    const results: HealthCheckResult[] = [];

    // Test top servers asynchronously with bounded concurrency
    for (let idx = 0; idx < Math.min(allServers.length, 6); idx++) {
      const server = allServers[idx];
      const serverId = server.id || server.urls[0];
      const result = await this.checkServerHealth(serverId, server);
      results.push(result);
      this.recordHealthCheck(serverId, result);
    }

    return results;
  }

  private async checkServerHealth(
    serverId: string,
    server: IceServerConfig
  ): Promise<HealthCheckResult> {
    const startTime = performance.now();

    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: server.urls }],
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Health check timeout')), this.healthCheckTimeout)
      );

      const healthCheckPromise = new Promise<number>((resolve, reject) => {
        let resolved = false;

        const cleanup = () => {
          resolved = true;
          pc.onicecandidate = null;
        };

        pc.onicecandidate = (event) => {
          if (event.candidate && !resolved) {
            cleanup();
            resolve(performance.now() - startTime);
          }
        };

        // Create data channel to trigger ICE negotiation
        pc.createDataChannel('health-check-probe');

        // Critical fix: must set local description to actually initiate ICE candidate gathering!
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .catch((err) => {
            cleanup();
            reject(err);
          });
      });

      const latency = await Promise.race([healthCheckPromise, timeoutPromise]);
      pc.close();

      return {
        serverId,
        healthy: true,
        latency,
        timestamp: Date.now(),
      };
    } catch (error) {
      return {
        serverId,
        healthy: false,
        latency: -1,
        error: String(error),
        timestamp: Date.now(),
      };
    }
  }

  public startHealthChecks(): void {
    if (this.healthCheckInterval) return;

    this.performHealthChecks().catch(() => {});
    this.healthCheckInterval = setInterval(() => {
      this.performHealthChecks().catch(() => {});
    }, this.healthCheckIntervalMs);
  }

  public stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  public getMetrics(): IceServerMetrics[] {
    return Array.from(this.metrics.values());
  }

  public destroy(): void {
    this.stopHealthChecks();
    this.metrics.clear();
    this.primaryPool = [];
    this.fallbackPool = [];
    this.turnPool = [];
  }
}

let instance: IceServerManager | null = null;

export function getIceServerManager(customServers?: string[] | IceServerConfig[]): IceServerManager {
  if (!instance) {
    instance = new IceServerManager(customServers);
    // Don't hammer mobile CPU/battery on startup; start probe after delay
    setTimeout(() => {
      instance?.startHealthChecks();
    }, 4000);
  }
  return instance;
}

export function destroyIceServerManager(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}
