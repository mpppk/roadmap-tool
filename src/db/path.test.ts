import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveDbPath } from "./path";

type EnvSnapshot = {
  ROADMAP_DB: string | undefined;
  XDG_DATA_HOME: string | undefined;
  HOME: string | undefined;
};

describe("resolveDbPath", () => {
  let snapshot: EnvSnapshot;

  beforeEach(() => {
    snapshot = {
      ROADMAP_DB: process.env.ROADMAP_DB,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      HOME: process.env.HOME,
    };
    // Start from a clean slate for each test
    delete process.env.ROADMAP_DB;
    delete process.env.XDG_DATA_HOME;
    process.env.HOME = "/home/testuser";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(snapshot) as [
      keyof EnvSnapshot,
      string | undefined,
    ][]) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("ROADMAP_DB takes priority over everything else", () => {
    process.env.ROADMAP_DB = "/custom/path/my.db";
    process.env.XDG_DATA_HOME = "/tmp/xdg";
    expect(resolveDbPath()).toBe("/custom/path/my.db");
  });

  it("uses XDG_DATA_HOME when it is an absolute path", () => {
    process.env.XDG_DATA_HOME = "/tmp/xdg";
    expect(resolveDbPath()).toBe("/tmp/xdg/roadmap-tool/db.sqlite");
  });

  it("falls back to $HOME/.local/share when XDG_DATA_HOME is not set", () => {
    expect(resolveDbPath()).toBe(
      "/home/testuser/.local/share/roadmap-tool/db.sqlite",
    );
  });

  it("ignores relative XDG_DATA_HOME and falls back to $HOME/.local/share", () => {
    process.env.XDG_DATA_HOME = "relative/xdg";
    expect(resolveDbPath()).toBe(
      "/home/testuser/.local/share/roadmap-tool/db.sqlite",
    );
  });

  it("ignores empty XDG_DATA_HOME and falls back to $HOME/.local/share", () => {
    process.env.XDG_DATA_HOME = "";
    expect(resolveDbPath()).toBe(
      "/home/testuser/.local/share/roadmap-tool/db.sqlite",
    );
  });
});
