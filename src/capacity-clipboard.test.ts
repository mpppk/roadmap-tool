import { describe, expect, test } from "bun:test";
import { parseCapacityTSV } from "./capacity-clipboard";

describe("parseCapacityTSV", () => {
  test("parses a single number", () => {
    expect(parseCapacityTSV("1.25")).toEqual([[1.25]]);
  });

  test("parses multiple TSV rows", () => {
    expect(parseCapacityTSV("1\t2\n3.5\t0")).toEqual([
      [1, 2],
      [3.5, 0],
    ]);
  });

  test("parses comma decimals", () => {
    expect(parseCapacityTSV("1,25\t0,5")).toEqual([[1.25, 0.5]]);
  });

  test("rejects empty text", () => {
    expect(parseCapacityTSV(" \n\t ")).toBeNull();
  });

  test("rejects non-numeric cells", () => {
    expect(parseCapacityTSV("1\tabc")).toBeNull();
  });

  test("rejects negative numbers", () => {
    expect(parseCapacityTSV("-1\t2")).toBeNull();
  });
});
