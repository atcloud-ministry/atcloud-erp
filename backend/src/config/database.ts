import type { ConnectOptions } from "mongoose";

/** Shared production-safe MongoDB client limits for the approved Atlas tier. */
export const MONGODB_CONNECTION_OPTIONS: Readonly<ConnectOptions> =
  Object.freeze({
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5_000,
    socketTimeoutMS: 45_000,
    bufferCommands: false,
  });
