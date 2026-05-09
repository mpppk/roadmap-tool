import { describe, expect, test } from "bun:test";
import {
  orpcProcedureNameFromPathname,
  shouldNotifyDataChange,
} from "./server";

describe("orpcProcedureNameFromPathname", () => {
  test("converts oRPC paths to dotted procedure names", () => {
    expect(orpcProcedureNameFromPathname("/orpc/epics/create")).toBe(
      "epics.create",
    );
    expect(orpcProcedureNameFromPathname("/orpc/members/setMaxCapacity")).toBe(
      "members.setMaxCapacity",
    );
    expect(orpcProcedureNameFromPathname("/orpc")).toBeNull();
  });
});

describe("shouldNotifyDataChange", () => {
  test("returns true for mutating procedures", () => {
    expect(shouldNotifyDataChange("/orpc/epics/create")).toBe(true);
    expect(shouldNotifyDataChange("/orpc/members/setMaxCapacity")).toBe(true);
    expect(shouldNotifyDataChange("/orpc/history/restore")).toBe(true);
    expect(shouldNotifyDataChange("/orpc/import/memberTSVImport")).toBe(true);
  });

  test("returns false for read-only procedures", () => {
    expect(shouldNotifyDataChange("/orpc/epics/list")).toBe(false);
    expect(shouldNotifyDataChange("/orpc/allocations/getEpicView")).toBe(false);
    expect(
      shouldNotifyDataChange("/orpc/allocations/previewMemberAllocation"),
    ).toBe(false);
    expect(shouldNotifyDataChange("/orpc/export/allocationTSV")).toBe(false);
    expect(shouldNotifyDataChange("/orpc/history/snapshot")).toBe(false);
  });
});
