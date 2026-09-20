import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * jsdom has no WebCrypto subtle by default. The hook falls back to a length
 * marker when subtle is missing, but we want the real hashing path under test
 * since "we store a hash, never the text" is the guarantee that matters.
 */
if (!globalThis.crypto?.subtle) {
  const { webcrypto } = await import("node:crypto");
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}
