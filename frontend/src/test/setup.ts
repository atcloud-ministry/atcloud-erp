import "@testing-library/jest-dom/vitest";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// 0) Setup proper localStorage and sessionStorage mocks that persist values in memory
const localStorageData: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => localStorageData[key] ?? null,
  setItem: (key: string, value: string) => {
    localStorageData[key] = value;
  },
  removeItem: (key: string) => {
    delete localStorageData[key];
  },
  clear: () => {
    Object.keys(localStorageData).forEach(
      (key) => delete localStorageData[key],
    );
  },
  get length() {
    return Object.keys(localStorageData).length;
  },
  key: (index: number) => {
    const keys = Object.keys(localStorageData);
    return keys[index] ?? null;
  },
};

const sessionStorageData: Record<string, string> = {};
const sessionStorageMock = {
  getItem: (key: string) => sessionStorageData[key] ?? null,
  setItem: (key: string, value: string) => {
    sessionStorageData[key] = value;
  },
  removeItem: (key: string) => {
    delete sessionStorageData[key];
  },
  clear: () => {
    Object.keys(sessionStorageData).forEach(
      (key) => delete sessionStorageData[key],
    );
  },
  get length() {
    return Object.keys(sessionStorageData).length;
  },
  key: (index: number) => {
    const keys = Object.keys(sessionStorageData);
    return keys[index] ?? null;
  },
};

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

Object.defineProperty(globalThis, "sessionStorage", {
  value: sessionStorageMock,
  writable: true,
  configurable: true,
});

// Clear both storages before each test
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // Set mock token by default for tests that expect it
  localStorage.setItem("authToken", "mock-token");
});

// 3) Mock browser history API for React Router to prevent "globalHistory.replaceState is not a function" errors
beforeAll(() => {
  // Mock the global history object that React Router uses
  Object.defineProperty(window, "history", {
    value: {
      length: 1,
      action: "POP",
      location: {
        pathname: "/",
        search: "",
        hash: "",
        state: null,
        key: "default",
      },
      pushState: vi.fn(),
      replaceState: vi.fn(),
      go: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      listen: vi.fn(() => vi.fn()), // Returns unsubscribe function
    },
    writable: true,
    configurable: true,
  });

  // Also mock the globalHistory object that may be used by React Router
  (globalThis as any).globalHistory = window.history;
});

// Ensure RTL unmounts components between tests
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
