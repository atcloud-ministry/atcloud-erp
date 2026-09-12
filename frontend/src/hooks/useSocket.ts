import { useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { resolveSocketURL } from "../config/apiUrl";
import { socketService } from "../services/socketService";
import type { EventUpdate } from "../types/realtime";

interface UseSocketOptions {
  baseUrl?: string;
  authToken?: string | null;
}

/** React lifecycle adapter for the application-wide socket service. */
export function useSocket({ baseUrl, authToken }: UseSocketOptions = {}) {
  const [connected, setConnected] = useState(socketService.isConnected);
  const [connectionLimited, setConnectionLimited] = useState(
    socketService.connectionStatus?.connectionLimited ?? false,
  );
  const [socket, setSocket] = useState<Socket | null>(socketService.socket);

  const token =
    authToken !== undefined
      ? authToken
      : typeof window !== "undefined"
        ? localStorage.getItem("token") || localStorage.getItem("authToken")
        : null;

  const url =
    baseUrl ??
    resolveSocketURL(
      import.meta.env.VITE_API_URL,
      import.meta.env.VITE_SOCKET_URL,
    );

  const connect = useCallback((): Socket | null => {
    if (!token) return null;
    const nextSocket = socketService.connect(token, url);
    setSocket(nextSocket);
    setConnected(nextSocket.connected);
    setConnectionLimited(
      socketService.connectionStatus?.connectionLimited ?? false,
    );
    return nextSocket;
  }, [token, url]);

  const disconnect = useCallback(() => {
    socketService.disconnect();
    setSocket(null);
    setConnected(false);
    setConnectionLimited(false);
  }, []);

  const onEventUpdate = useCallback(
    (handler: (update: EventUpdate) => void) =>
      socketService.on("event_update", handler),
    [],
  );

  useEffect(() => {
    if (!token) {
      setSocket(null);
      setConnected(false);
      setConnectionLimited(false);
      return;
    }

    const handleConnect = () => {
      setSocket(socketService.socket);
      setConnected(true);
      setConnectionLimited(false);
    };
    const handleDisconnect = () => {
      setConnected(false);
      setConnectionLimited(
        socketService.connectionStatus?.connectionLimited ?? false,
      );
    };
    const handleConnectionLimit = () => {
      setConnectionLimited(true);
      setConnected(false);
    };

    const stopListeningForConnect = socketService.on(
      "connect",
      handleConnect,
    );
    const stopListeningForDisconnect = socketService.on(
      "disconnect",
      handleDisconnect,
    );
    const stopListeningForConnectionLimit = socketService.on(
      "connection_limit",
      handleConnectionLimit,
    );
    const releaseConnection = socketService.acquire(token, url);

    setSocket(socketService.socket);
    setConnected(socketService.isConnected);

    return () => {
      stopListeningForConnect();
      stopListeningForDisconnect();
      stopListeningForConnectionLimit();
      releaseConnection();
    };
  }, [token, url]);

  return {
    socket,
    connected,
    connectionLimited,
    connect,
    disconnect,
    onEventUpdate,
  } as const;
}
