import WebSocket from "ws";
import { logger } from "../../utils/logger.js";
import { nextBackoff, sleep } from "../../utils/retry.js";
import { decodeAngelTick, type DecodedTick } from "./decoder.js";
import type { Instrument } from "../types.js";

const WS_URL = "wss://smartapisocket.angelone.in/smart-stream";
const HEARTBEAT_MS = 25_000;

export interface AngelWsConfig {
  apiKey: string;
  clientCode: string;
  feedToken: string;
  jwtToken: string;
  subscriptionMode: number;
}

export type AngelWsEvents = {
  onTick: (t: DecodedTick) => void;
  onOpen: () => void;
  onClose: (code: number, reason: string) => void;
  onError: (err: Error) => void;
  /**
   * Optional auth refresh hook invoked before every reconnect attempt.
   * Must resolve with the (possibly unchanged) credentials to use.
   */
  onNeedAuth?: () => Promise<Partial<AngelWsConfig>>;
};

const key = (i: Instrument): string => `${i.exchangeType}:${i.token}`;

function dedupe(list: Instrument[]): Instrument[] {
  const seen = new Set<string>();
  const out: Instrument[] = [];
  for (const i of list) {
    if (seen.has(key(i))) continue;
    seen.add(key(i));
    out.push(i);
  }
  return out;
}



export class AngelOneWebSocket {
  private ws: WebSocket | null = null;
  private hbTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private reconnectAttempt = 0;
  private instruments: Instrument[] = [];
  private recovering = false;
  public reconnectCount = 0;

  constructor(
    private cfg: AngelWsConfig,
    private events: AngelWsEvents,
  ) {}

  updateTokens(cfg: Partial<AngelWsConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  async connect(): Promise<void> {
    this.closed = false;
    await this.open();
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL, {
        headers: {
          Authorization: this.cfg.jwtToken,
          "x-api-key": this.cfg.apiKey,
          "x-client-code": this.cfg.clientCode,
          "x-feed-token": this.cfg.feedToken,
        },
        handshakeTimeout: 15_000,
      });
      this.ws = ws;

      ws.on("open", () => {
        logger.info("[angelone.ws] connected");
        if (this.recovering) {
          this.recovering = false;
          logger.info(
            { reconnectCount: this.reconnectCount },
            "[angelone.auth] websocket recovered after reconnect",
          );
        }
        this.reconnectAttempt = 0;
        this.startHeartbeat();
        if (this.instruments.length > 0) {
          this.sendSubscribe(this.instruments).catch((err) =>
            logger.error({ err }, "[angelone.ws] resubscribe failed"),
          );
        }
        this.events.onOpen();
        resolve();
      });

      ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        const tick = decodeAngelTick(buf);
        if (tick) this.events.onTick(tick);
      });

      ws.on("close", (code, reasonBuf) => {
        const reason = reasonBuf?.toString?.() ?? "";
        logger.warn({ code, reason }, "[angelone.ws] closed");
        this.stopHeartbeat();
        this.events.onClose(code, reason);
        if (!this.closed) void this.scheduleReconnect();
      });

      ws.on("error", (err) => {
        logger.error({ err: err.message }, "[angelone.ws] error");
        this.events.onError(err);
      });

      ws.once("error", (err) => reject(err));
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.hbTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send("ping");
        } catch (err) {
          logger.warn({ err }, "[angelone.ws] heartbeat send failed");
        }
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  private async scheduleReconnect(): Promise<void> {
    const wait = nextBackoff(this.reconnectAttempt++);
    logger.info({ waitMs: wait }, "[angelone.ws] scheduling reconnect");
    await sleep(wait);
    if (this.closed) return;
    this.reconnectCount++;
    try {
      // Refresh credentials (single-flighted by the provider) before reopening,
      // so an expired jwt/feed token never causes a permanent 401 loop.
      if (this.events.onNeedAuth) {
        const fresh = await this.events.onNeedAuth();
        if (fresh) this.updateTokens(fresh);
      }
      this.recovering = true;
      await this.open();
    } catch (err) {
      this.recovering = false;
      logger.error({ err }, "[angelone.ws] reconnect attempt failed");
      void this.scheduleReconnect();
    }
  }

  async subscribe(instruments: Instrument[]): Promise<void> {
    this.instruments = dedupe(instruments);
    if (this.ws?.readyState === WebSocket.OPEN) {
      await this.sendSubscribe(this.instruments);
    }
  }

  /** Currently tracked subscription list (survives reconnects). */
  getInstruments(): Instrument[] {
    return [...this.instruments];
  }

  /**
   * Additive subscribe — sends a subscribe frame for `add` only and merges it
   * into the tracked list. Idempotent: already-tracked instruments are skipped.
   */
  async subscribeInstruments(add: Instrument[]): Promise<void> {
    const known = new Set(this.instruments.map(key));
    const fresh = dedupe(add).filter((i) => !known.has(key(i)));
    if (fresh.length === 0) return;
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("websocket not open — cannot subscribe");
    }
    await this.sendSubscribe(fresh);
    this.instruments = [...this.instruments, ...fresh];
  }

  /** Removes `remove` from the tracked list and sends an unsubscribe frame. */
  async unsubscribeInstruments(remove: Instrument[]): Promise<void> {
    const drop = new Set(dedupe(remove).map(key));
    const present = this.instruments.filter((i) => drop.has(key(i)));
    if (present.length === 0) return;
    this.instruments = this.instruments.filter((i) => !drop.has(key(i)));
    if (this.ws?.readyState === WebSocket.OPEN) {
      await this.sendAction(present, 0);
    }
  }

  private async sendSubscribe(instruments: Instrument[]): Promise<void> {
    await this.sendAction(instruments, 1);
  }

  private async sendAction(instruments: Instrument[], action: 0 | 1): Promise<void> {
    // Group by exchangeType
    const grouped = new Map<number, string[]>();
    for (const i of instruments) {
      const arr = grouped.get(i.exchangeType) ?? [];
      arr.push(i.token);
      grouped.set(i.exchangeType, arr);
    }
    const tokenList = Array.from(grouped.entries()).map(([exchangeType, tokens]) => ({
      exchangeType,
      tokens,
    }));

    const payload = {
      correlationID: `rb-${Date.now()}`,
      action, // 1 = subscribe, 0 = unsubscribe
      params: {
        mode: this.cfg.subscriptionMode,
        tokenList,
      },
    };
    this.ws?.send(JSON.stringify(payload));
    logger.info(
      { tokenList, mode: this.cfg.subscriptionMode, action },
      `[angelone.ws] ${action === 1 ? "subscribe" : "unsubscribe"} sent`,
    );
  }


  async disconnect(): Promise<void> {
    this.closed = true;
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}
