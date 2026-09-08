import { describe, expect, it } from "vitest";
import { parseCli } from "./cli.js";

describe("command-line configuration", () => {
  it("selects explicit user-data recovery without requiring a valid transport", () => {
    expect(
      parseCli(["restore-user-data", "/safe backup/user-data.sqlite"], {
        MCP_TRANSPORT: "broken",
      }),
    ).toEqual({
      mode: "restore-user-data",
      backupPath: "/safe backup/user-data.sqlite",
    });
  });

  it.each([
    ["restore-user-data"],
    ["restore-user-data", ""],
    ["restore-user-data", "--http"],
    ["restore-user-data", "backup.sqlite", "--stdio"],
  ])("rejects an incomplete or mixed restore invocation: %j", (...argv) => {
    expect(() => parseCli(argv, {})).toThrow("restore-user-data");
  });

  it("rejects an empty restore data directory", () => {
    expect(() => parseCli(["restore-user-data", "backup.sqlite"], { MCP_DATA_DIR: " " })).toThrow(
      "MCP_DATA_DIR",
    );
  });

  it("handles help and version before any startup configuration", () => {
    expect(parseCli(["--help"], { MCP_TRANSPORT: "broken" })).toEqual({
      mode: "help",
    });
    expect(parseCli(["-v"], {})).toEqual({ mode: "version" });
  });

  it("defaults to stdio and supports an explicit transport override", () => {
    expect(parseCli([], {})).toMatchObject({
      mode: "serve",
      transport: "stdio",
    });
    expect(parseCli(["--stdio"], { MCP_TRANSPORT: "http" })).toMatchObject({
      transport: "stdio",
    });
    expect(parseCli(["--http"], { MCP_HTTP_PORT: "0", MCP_HTTP_HOST: "::1" })).toMatchObject({
      transport: "http",
      port: 0,
      host: "::1",
    });
  });

  it.each(["--wat", "serve", "--port=3000"])("rejects unknown argument %s", (arg) => {
    expect(() => parseCli([arg], {})).toThrow("Unknown argument");
  });

  it("rejects conflicting transport flags and unknown environment transport", () => {
    expect(() => parseCli(["--http", "--stdio"], {})).toThrow("Choose");
    expect(() => parseCli([], { MCP_TRANSPORT: "htttp" })).toThrow("MCP_TRANSPORT");
  });

  it.each(["", "abc", "-1", "65536", "2.5", "1e3"])("rejects invalid port %s", (port) => {
    expect(() => parseCli(["--http"], { MCP_HTTP_PORT: port })).toThrow("MCP_HTTP_PORT");
  });

  it("rejects remote binding and an empty data path", () => {
    expect(() => parseCli(["--http"], { MCP_HTTP_HOST: "0.0.0.0" })).toThrow("loopback");
    expect(() => parseCli([], { MCP_DATA_DIR: " " })).toThrow("MCP_DATA_DIR");
  });

  it("ignores HTTP-only environment settings in stdio mode", () => {
    expect(parseCli([], { MCP_HTTP_PORT: "invalid", MCP_HTTP_HOST: "invalid" })).toMatchObject({
      transport: "stdio",
    });
  });
});
