import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SignInPage from "./page";

const replace = vi.fn();
let params = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  useSearchParams: () => params,
}));

function mockProviders(providers: { id: string; label: string }[]) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, json: async () => ({ providers }), text: async () => "",
  } as Response)));
}

beforeEach(() => { params = new URLSearchParams(); replace.mockClear(); localStorage.clear(); });
afterEach(() => { localStorage.clear(); });

describe("sign-in", () => {
  it("offers only the providers the server has configured", async () => {
    mockProviders([{ id: "github", label: "GitHub" }]);
    render(<SignInPage />);
    await waitFor(() => expect(screen.getByText(/Continue with GitHub/)).toBeInTheDocument());
    expect(screen.queryByText(/Continue with Google/)).not.toBeInTheDocument();
  });

  it("shows no provider buttons when none are configured", async () => {
    mockProviders([]);
    render(<SignInPage />);
    await waitFor(() => expect(screen.getByLabelText("Email")).toBeInTheDocument());
    expect(screen.queryByText(/Continue with/)).not.toBeInTheDocument();
  });

  it("STATES WHAT THE PROVIDER IS ASKED FOR — authors are wary of this", async () => {
    mockProviders([{ id: "github", label: "GitHub" }]);
    render(<SignInPage />);
    await waitFor(() => expect(screen.getByText(/who you are and nothing else/)).toBeInTheDocument());
    expect(screen.getByText(/no access to your repositories or files/)).toBeInTheDocument();
  });

  it("keeps email sign-in available alongside providers", async () => {
    mockProviders([{ id: "github", label: "GitHub" }, { id: "google", label: "Google" }]);
    render(<SignInPage />);
    await waitFor(() => expect(screen.getByText(/Continue with Google/)).toBeInTheDocument());
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("surfaces a refusal from the callback instead of failing silently", async () => {
    params = new URLSearchParams({ error: "GitHub has not verified mara@example.com" });
    mockProviders([]);
    render(<SignInPage />);
    await waitFor(() =>
      expect(screen.getByText(/GitHub has not verified mara@example.com/)).toBeInTheDocument());
  });

  it("stores a session handed back by the callback and moves on", async () => {
    params = new URLSearchParams({ session: "gls_from_provider" });
    mockProviders([]);
    render(<SignInPage />);
    await waitFor(() => expect(localStorage.getItem("gitlit_session")).toBe("gls_from_provider"));
    expect(replace).toHaveBeenCalledWith("/");
  });
});

describe("arriving from the emailed link", () => {
  const TOKEN = "glm_0123456789abcdef01_" + "a".repeat(64);

  it("does NOT sign you in just by loading the page", async () => {
    // A mail gateway prefetching the link must not spend it. Landing here is
    // a GET that renders; only the click posts.
    params = new URLSearchParams({ token: TOKEN });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true, json: async () => ({ providers: [] }), text: async () => "",
    } as Response));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<SignInPage />);
    await waitFor(() => expect(screen.getByText(/One more tap/)).toBeInTheDocument());

    const posted = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posted).toHaveLength(0);
  });

  it("takes the token out of the URL so it cannot leak by Referer", async () => {
    params = new URLSearchParams({ token: TOKEN });
    mockProviders([]);
    render(<SignInPage />);
    await waitFor(() => expect(screen.getByText(/One more tap/)).toBeInTheDocument());
    expect(window.location.search).toBe("");
  });

  it("never shows the token on screen", async () => {
    params = new URLSearchParams({ token: TOKEN });
    mockProviders([]);
    render(<SignInPage />);
    await waitFor(() => expect(screen.getByText(/One more tap/)).toBeInTheDocument());
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(screen.queryByLabelText("Sign-in token")).not.toBeInTheDocument();
  });

  it("signs in with the token from the link when the button is clicked", async () => {
    params = new URLSearchParams({ token: TOKEN });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/v1/auth/session")) {
        return { ok: true, json: async () => ({ sessionToken: "gls_live" }), text: async () => "" } as Response;
      }
      return { ok: true, json: async () => ({ providers: [] }), text: async () => "" } as Response;
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<SignInPage />);
    await waitFor(() => expect(screen.getByText(/One more tap/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(localStorage.getItem("gitlit_session")).toBe("gls_live"));
    const [, init] = fetchMock.mock.calls.find(
      ([u]) => String(u).endsWith("/v1/auth/session"))! as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN });
  });

  it("says the link failed rather than leaving the button spinning", async () => {
    params = new URLSearchParams({ token: TOKEN });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (
      String(url).endsWith("/v1/auth/session")
        ? { ok: false, json: async () => ({}), text: async () => "" } as Response
        : { ok: true, json: async () => ({ providers: [] }), text: async () => "" } as Response
    )) as unknown as typeof fetch);

    render(<SignInPage />);
    await waitFor(() => expect(screen.getByText(/One more tap/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(screen.getByText(/invalid, already used, or expired/)).toBeInTheDocument());
  });
});

describe("when the mail provider is down", () => {
  it("tells the author the email did not go out", async () => {
    mockProviders([]);
    render(<SignInPage />);
    await waitFor(() => expect(screen.getByLabelText("Email")).toBeInTheDocument());

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      json: async () => ({ detail: "We could not send the sign-in email just now." }),
      text: async () => "",
    } as Response)));

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.co" } });
    fireEvent.click(screen.getByRole("button", { name: /Email me a link/ }));

    await waitFor(() =>
      expect(screen.getByText(/could not send the sign-in email/i)).toBeInTheDocument());
    // and does not pretend a link is on its way
    expect(screen.queryByText(/a link is on its way/)).not.toBeInTheDocument();
  });
});
