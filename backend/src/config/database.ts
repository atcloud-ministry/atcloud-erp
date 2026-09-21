import type { ConnectOptions } from "mongoose";

/** Shared production-safe MongoDB client limits, including the Atlas Flex cap. */
export const MONGODB_CONNECTION_OPTIONS: Readonly<ConnectOptions> =
  Object.freeze({
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5_000,
    socketTimeoutMS: 45_000,
    bufferCommands: false,
  });
