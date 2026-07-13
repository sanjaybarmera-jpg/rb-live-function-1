import pino from "pino";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "rb-live-engine" },
  transport:
    env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" } }
      : undefined,
});

export type Logger = typeof logger;
