import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
