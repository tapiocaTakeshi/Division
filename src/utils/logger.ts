import fs from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "ai.log");

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

export enum LogLevel {
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
  DEBUG = "DEBUG",
}

class Logger {
  private static instance: Logger;

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private formatMessage(level: LogLevel, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` | Data: ${JSON.stringify(data)}` : "";
    return `[${timestamp}] [${level}] ${message}${dataStr}`;
  }

  private write(level: LogLevel, message: string, data?: any) {
    const formatted = this.formatMessage(level, message, data);
    
    // Always log to console
    if (level === LogLevel.ERROR) {
      console.error(formatted);
    } else if (level === LogLevel.WARN) {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }

    // Append to file
    try {
      fs.appendFileSync(LOG_FILE, formatted + "\n");
    } catch (err) {
      console.error(`Failed to write to log file: ${err}`);
    }
  }

  public info(message: string, data?: any) {
    this.write(LogLevel.INFO, message, data);
  }

  public warn(message: string, data?: any) {
    this.write(LogLevel.WARN, message, data);
  }

  public error(message: string, data?: any) {
    this.write(LogLevel.ERROR, message, data);
  }

  public debug(message: string, data?: any) {
    this.write(LogLevel.DEBUG, message, data);
  }
}

export const logger = Logger.getInstance();
