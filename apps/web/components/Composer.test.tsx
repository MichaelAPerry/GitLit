import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./Composer";

/**
 * GitLit Write (§7.5).
 *
 * The editor is the only place most authors will ever see the provenance
 * system, so these cover both the plumbing — sessions opened, synced and
 * closed — and the wording, which is deliberate: the panel is an account of
 * the author's work, not a report on their conduct.
 */
const calls: { url: string; init?: RequestInit }[] = [];

function mockApi(overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body =
      url.includes("/sessions") && init?.method === "POST"
        ? { sessionId: "as_test", path: "p", startedAt: "now" }
        : url.includes("/documents")
          ? { sha: "abcdef1234", provenance: "human" }
          : { ok: true };
    return {
      ok: true,
      json: async () => ({ ...body, ...overrides }),
      text: async () => JSON.stringify(body),
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const LONG = "The lighthouse had been dark for eleven years. ".repeat(12);

function paste(el: Element, text: string) {
  const event = new Event("paste", { bubbles: true }) as Event & { clipboardData: unknown };
  event.clipboardData = { getData: () => text };
  fireEvent(el, event);
}

/**
 * The editor autosaves on a pause. Waiting that out in real time makes the
 * suite slow enough that people stop running it, so the clock is advanced
 * instead — the behaviour under test is the debounce, not the wall time.
 */
async function settle(ms = 3000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

const renderComposer = (content = "") =>
  render(<Composer owner="mara" slug="saltmarsh" path="manuscript/chapters/01.md" initialContent={content} />);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  calls.length = 0;
  localStorage.setItem("gitlit_session", "gls_testsession");
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("rendering", () => {
  it("shows the initial content and its word count", () => {
    renderComposer("One two three four five.");
    expect(screen.getByRole("textbox")).toHaveValue("One two three four five.");
    expect(screen.getByText(/5 words/)).toBeInTheDocument();
  });

  it("updates the count as the author writes", async () => {
    mockApi();
    renderComposer();
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "One two three." } });
    });
    expect(screen.getByText(/3 words/)).toBeInTheDocument();
  });

  it("offers a way back to the book", () => {
    renderComposer();
    expect(screen.getByRole("link", { name: /saltmarsh/ })).toBeInTheDocument();
  });
});

describe("saving", () => {
  it("does not save an untouched document", async () => {
    mockApi();
    renderComposer("Already written.");
    await settle();
    expect(calls.filter((c) => c.init?.method === "PUT")).toHaveLength(0);
  });

  it("opens an authoring session and saves after a pause", async () => {
    mockApi();
    renderComposer();
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "A new sentence." } });
    });
    await settle();
    expect(calls.some((c) => c.init?.method === "PUT")).toBe(true);

    expect(calls.some((c) => c.url.includes("/sessions") && c.init?.method === "POST")).toBe(true);
    expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true);
  });

  it("syncs the session BEFORE the commit, so evidence is server-derived", async () => {
    mockApi();
    renderComposer();
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "A new sentence." } });
    });
    await settle();
    expect(calls.some((c) => c.init?.method === "PUT")).toBe(true);

    const patchAt = calls.findIndex((c) => c.init?.method === "PATCH");
    const putAt = calls.findIndex((c) => c.init?.method === "PUT");
    expect(patchAt).toBeGreaterThanOrEqual(0);
    expect(patchAt).toBeLessThan(putAt);
  });

  it("sends the session id with the commit rather than asserting evidence itself", async () => {
    mockApi();
    renderComposer();
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "A new sentence." } });
    });
    await settle();
    expect(calls.some((c) => c.init?.method === "PUT")).toBe(true);

    const put = calls.find((c) => c.init?.method === "PUT")!;
    const body = JSON.parse(String(put.init!.body));
    expect(body.authoringSessionId).toBe("as_test");
    expect(body.evidence).toBeUndefined();
  });

  it("authenticates every request", async () => {
    mockApi();
    renderComposer();
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "A new sentence." } });
    });
    await settle();
    expect(calls.some((c) => c.init?.method === "PUT")).toBe(true);

    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string> | undefined;
      expect(headers?.authorization, call.url).toBe("Bearer gls_testsession");
    }
  });

  it("reports the commit and how it was recorded", async () => {
    mockApi();
    renderComposer();
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "A new sentence." } });
    });
    await settle();
    expect(screen.getByText(/recorded as human/)).toBeInTheDocument();
    expect(screen.getByText(/abcdef1/)).toBeInTheDocument();
  });

  it("says so plainly when the API is unreachable, and keeps the text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    renderComposer();
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsaved words." } });
    });
    await settle();
    expect(screen.getByText(/Could not save/)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Unsaved words.");
  });

  it("closes the session when the editor unmounts", async () => {
    mockApi();
    const { unmount } = renderComposer();
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "A new sentence." } });
    });
    await settle();
    expect(calls.some((c) => c.init?.method === "PUT")).toBe(true);
    await act(async () => { unmount(); });
    expect(calls.some((c) => c.url.includes("/close"))).toBe(true);
  });
});

describe("the session record panel", () => {
  it("is hidden until asked for", () => {
    renderComposer();
    expect(screen.queryByText(/What this session recorded/)).not.toBeInTheDocument();
  });

  it("states that typing is counted and never logged", async () => {
    mockApi();
    renderComposer();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Session record/ })); });
    expect(screen.getByText(/never logged/)).toBeInTheDocument();
    expect(screen.getByText(/no keystroke content leaves your browser/i)).toBeInTheDocument();
  });

  it("reports an honest zero when nothing was pasted", async () => {
    mockApi();
    renderComposer();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Session record/ })); });
    expect(screen.getByText(/No pastes over the threshold/)).toBeInTheDocument();
  });

  it("REPORTS A PASTE WITHOUT ACCUSING — pasting is normal", async () => {
    mockApi();
    renderComposer();
    await act(async () => { paste(screen.getByRole("textbox"), LONG); });
    await settle(10);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Session record/ })); });

    expect(screen.getByText(/1 paste of/)).toBeInTheDocument();
    const panel = screen.getByText(/Pasting is normal/);
    expect(panel).toBeInTheDocument();
    expect(panel.textContent).toMatch(/recorded as a fact, not a suspicion/);
    // The author's account is stored separately from what was observed.
    expect(panel.textContent).toMatch(/your account of it, separate from what we observed/);
  });

  it("uses no accusatory language anywhere in the panel", async () => {
    mockApi();
    renderComposer();
    await act(async () => { paste(screen.getByRole("textbox"), LONG); });
    await settle(10);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Session record/ })); });
    const text = document.body.textContent ?? "";
    for (const word of ["suspicious", "cheat", "violation", "detected", "flagged"]) {
      expect(text.toLowerCase(), word).not.toContain(word);
    }
  });
});
