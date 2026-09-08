import { describe, it, expect } from "vitest";

describe("scaffold", () => {
  it("imports @modelcontextprotocol/server", async () => {
    const sdk = await import("@modelcontextprotocol/server");
    expect(sdk.Server).toBeTypeOf("function");
  });

  it("imports and runs better-sqlite3 (native addon loads on this platform)", async () => {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(":memory:");
    const row = db.prepare("select 1 + 1 as n").get() as { n: number };
    db.close();
    expect(row.n).toBe(2);
  });
});
