import { describe, expect, it } from "vitest";
import { classifyResponse } from "@/lib/cloudBgRemoval";

describe("classifyResponse", () => {
  it("returns 'rate-limited' for 429", () => {
    expect(classifyResponse(429)).toEqual({ kind: "rate-limited" });
  });

  it("returns 'http' with status for 5xx", () => {
    expect(classifyResponse(500)).toEqual({ kind: "http", status: 500 });
    expect(classifyResponse(502)).toEqual({ kind: "http", status: 502 });
  });

  it("returns 'http' with status for unexpected 4xx", () => {
    expect(classifyResponse(401)).toEqual({ kind: "http", status: 401 });
  });

  it("returns null for 200", () => {
    expect(classifyResponse(200)).toBeNull();
  });
});
