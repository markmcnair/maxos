import winston from "winston";
import { join } from "node:path";
import { homedir } from "node:os";

const MAXOS_HOME = process.env.MAXOS_HOME || join(homedir(), ".maxos");

export const logger = winston.createLogger({
  level: process.env.MAXOS_LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: join(MAXOS_HOME, "daemon.log"),
      maxsize: 5_000_000, // 5MB
      maxFiles: 3,
    }),
  ],
});

// Add console transport when running in foreground
export function enableConsoleLogging(): void {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    })
  );
}
