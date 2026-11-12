import { describe, expect, it, vi } from "vitest";
import { fakeApi } from "../test/helpers";
import { ApiError, api, errorMessage, fieldErrors, setCurrentOrgId } from "./api";

describe("api", () => {
  it("returns the parsed body of a successful response", async () => {
    fakeApi({ "GET /v1/endpoints": { body: [{ id: "e1" }] } });

    await expect(api("/v1/endpoints")).resolves.toEqual([{ id: "e1" }]);
  });

  it("sends the current organisation and a JSON body", async () => {
    setCurrentOrgId("org-42");
    const calls = fakeApi({ "POST /v1/api-keys": { status: 201, body: { id: "k1" } } });

    await api("/v1/api-keys", { method: "POST", body: { name: "backend" } });

    expect(calls[0]?.headers["X-Org-ID"]).toBe("org-42");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual({ name: "backend" });
  });

  it("leaves out empty query values", async () => {
    const calls = fakeApi({ "GET /v1/deliveries": { body: { items: [] } } });

    await api("/v1/deliveries", { query: { status: "dead", endpoint_id: "", cursor: null } });

    expect(calls[0]?.path).toBe("/v1/deliveries?status=dead");
  });

  it("returns undefined for 204 No Content", async () => {
    fakeApi({ "DELETE /v1/api-keys/k1": { status: 204 } });

    await expect(api("/v1/api-keys/k1", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("turns an error response into an ApiError with code and request id", async () => {
    fakeApi({
      "GET /v1/endpoints/x": {
        status: 404,
        body: { code: "endpoint_not_found", message: "No such endpoint.", request_id: "req-9" },
      },
    });

    const error = await api("/v1/endpoints/x").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      code: "endpoint_not_found",
      message: "No such endpoint.",
      requestId: "req-9",
    });
  });

  it("copes with an error that is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })),
    );

    const error = await api("/v1/endpoints").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 502, code: "unknown_error" });
  });

  it("reports a network failure as a readable error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(api("/v1/endpoints")).rejects.toMatchObject({ code: "network_error" });
  });
});

describe("session refresh", () => {
  it("refreshes once and retries when the access token has expired", async () => {
    let expired = true;
    const calls = fakeApi({
      "GET /v1/endpoints": () =>
        expired ? { status: 401, body: { code: "not_authenticated" } } : { body: ["ok"] },
      "POST /v1/auth/refresh": () => {
        expired = false;
        return { body: {} };
      },
    });

    await expect(api("/v1/endpoints")).resolves.toEqual(["ok"]);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/endpoints",
      "POST /v1/auth/refresh",
      "GET /v1/endpoints",
    ]);
  });

  it("gives up with the 401 when the refresh fails too", async () => {
    const calls = fakeApi({
      "GET /v1/endpoints": { status: 401, body: { code: "not_authenticated", message: "Log in." } },
      "POST /v1/auth/refresh": { status: 401, body: { code: "invalid_session" } },
    });

    await expect(api("/v1/endpoints")).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(2); // no endless retry
  });

  it("shares one refresh between requests that fail together", async () => {
    let expired = true;
    let refreshes = 0;
    fakeApi({
      "GET /v1/a": () => (expired ? { status: 401, body: {} } : { body: "a" }),
      "GET /v1/b": () => (expired ? { status: 401, body: {} } : { body: "b" }),
      "POST /v1/auth/refresh": () => {
        refreshes += 1;
        expired = false;
        return { body: {} };
      },
    });

    await expect(Promise.all([api("/v1/a"), api("/v1/b")])).resolves.toEqual(["a", "b"]);
    // A refresh token works exactly once, so two refreshes would log the user out.
    expect(refreshes).toBe(1);
  });

  it("does not try to refresh for the login request itself", async () => {
    const calls = fakeApi({
      "POST /v1/auth/login": { status: 401, body: { code: "invalid_credentials", message: "No." } },
    });

    await expect(
      api("/v1/auth/login", { method: "POST", body: {}, skipRefresh: true }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(calls).toHaveLength(1);
  });
});

describe("error helpers", () => {
  it("maps validation details to field names", () => {
    const error = new ApiError(422, "validation_error", "The request is not valid.", [
      { loc: ["body", "password"], msg: "String should have at least 10 characters" },
      { loc: ["body", "email"], msg: "value is not a valid email address" },
    ]);

    expect(fieldErrors(error)).toEqual({
      password: "String should have at least 10 characters",
      email: "value is not a valid email address",
    });
  });

  it("returns no field errors for other failures", () => {
    expect(fieldErrors(new ApiError(500, "internal_error", "Oops"))).toEqual({});
    expect(fieldErrors(new Error("boom"))).toEqual({});
    expect(fieldErrors(undefined)).toEqual({});
  });

  it("always produces a message a person can read", () => {
    expect(errorMessage(new ApiError(409, "email_taken", "Already registered."))).toBe(
      "Already registered.",
    );
    expect(errorMessage("weird")).toBe("Something went wrong.");
  });
});
