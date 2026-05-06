export type NameResource = "feature" | "member" | "epic";
export type NameErrorCode = "DUPLICATE_NAME" | "BLANK_NAME";

export const NAME_ERROR_MESSAGES: Record<NameResource, string> & {
  blank: string;
} = {
  feature: "Feature名は重複できません。別の名前を入力してください。",
  member: "Member名は重複できません。別の名前を入力してください。",
  epic: "Epic名は重複できません。別の名前を入力してください。",
  blank: "名前は空にできません。",
};

export function trimSqliteSpaces(value: string): string {
  return value.replace(/^ +| +$/g, "");
}

export function nextAvailableGeneratedName(
  prefix: "Feature" | "Member" | "Epic",
  existingNames: Iterable<string>,
): string {
  const used = new Set(existingNames);
  for (let index = 1; ; index += 1) {
    const candidate = `${prefix} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function isNameErrorCode(value: unknown): value is NameErrorCode {
  return value === "DUPLICATE_NAME" || value === "BLANK_NAME";
}

function resourceMessage(resource: unknown): string | null {
  if (resource === "feature") return NAME_ERROR_MESSAGES.feature;
  if (resource === "member") return NAME_ERROR_MESSAGES.member;
  if (resource === "epic") return NAME_ERROR_MESSAGES.epic;
  return null;
}

export function getNameErrorMessage(error: unknown): string | null {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  const code = data?.code ?? record?.code;

  if (isNameErrorCode(code)) {
    if (typeof record?.message === "string" && record.message) {
      return record.message;
    }
    if (code === "BLANK_NAME") return NAME_ERROR_MESSAGES.blank;
    return resourceMessage(data?.resource ?? record?.resource);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (
    message === NAME_ERROR_MESSAGES.blank ||
    message === NAME_ERROR_MESSAGES.feature ||
    message === NAME_ERROR_MESSAGES.member ||
    message === NAME_ERROR_MESSAGES.epic
  ) {
    return message;
  }

  return null;
}
