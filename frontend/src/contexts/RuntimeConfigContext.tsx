import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  FAIL_CLOSED_RUNTIME_CONFIG,
  fetchRuntimeConfig,
} from "../config/runtimeConfig";
import type { RuntimeConfig } from "../config/runtimeConfig";

export type RuntimeConfigStatus = "loading" | "ready" | "error";

export interface RuntimeConfigContextValue {
  readonly config: RuntimeConfig;
  readonly status: RuntimeConfigStatus;
  readonly refresh: () => Promise<void>;
}

const DEFAULT_CONTEXT_VALUE: RuntimeConfigContextValue = Object.freeze({
  config: FAIL_CLOSED_RUNTIME_CONFIG,
  status: "error",
  refresh: async () => undefined,
});

const RuntimeConfigContext = createContext<RuntimeConfigContextValue>(
  DEFAULT_CONTEXT_VALUE,
);

interface RuntimeConfigState {
  readonly config: RuntimeConfig;
  readonly status: RuntimeConfigStatus;
}

const INITIAL_STATE: RuntimeConfigState = Object.freeze({
  config: FAIL_CLOSED_RUNTIME_CONFIG,
  status: "loading",
});

export function RuntimeConfigProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RuntimeConfigState>(INITIAL_STATE);
  const mountedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    activeRequestRef.current?.abort();

    const controller = new AbortController();
    activeRequestRef.current = controller;

    if (mountedRef.current) {
      setState(INITIAL_STATE);
    }

    try {
      const config = await fetchRuntimeConfig(controller.signal);
      if (
        mountedRef.current &&
        requestSequence === requestSequenceRef.current
      ) {
        setState({ config, status: "ready" });
      }
    } catch {
      if (
        mountedRef.current &&
        requestSequence === requestSequenceRef.current
      ) {
        setState({
          config: FAIL_CLOSED_RUNTIME_CONFIG,
          status: "error",
        });
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) {
        activeRequestRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();

    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, [refresh]);

  const value = useMemo<RuntimeConfigContextValue>(
    () => ({ ...state, refresh }),
    [refresh, state],
  );

  return (
    <RuntimeConfigContext.Provider value={value}>
      {children}
    </RuntimeConfigContext.Provider>
  );
}

export function useRuntimeConfig(): RuntimeConfigContextValue {
  return useContext(RuntimeConfigContext);
}
