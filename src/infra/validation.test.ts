import { describe, it, expect } from "vitest";
import {
  isValidIssueId,
  isValidUuid,
  isValidTeamId,
  sanitizeForPrompt,
} from "./validation.js";

// ---------------------------------------------------------------------------
// isValidUuid
// ---------------------------------------------------------------------------

describe("isValidUuid", () => {
  it("accepts valid lowercase UUID", () => {
    expect(isValidUuid("08cba264-d774-4afd-bc93-ee8213d12ef8")).toBe(true);
  });

  it("accepts valid uppercase UUID", () => {
    expect(isValidUuid("08CBA264-D774-4AFD-BC93-EE8213D12EF8")).toBe(true);
  });

  it("accepts mixed-case UUID", () => {
    expect(isValidUuid("08CbA264-d774-4aFd-Bc93-ee8213D12ef8")).toBe(true);
  });

  it("rejects short string", () => {
    expect(isValidUuid("abc-123")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidUuid("")).toBe(false);
  });

  it("rejects UUID without dashes", () => {
    expect(isValidUuid("08cba264d7744afdbc93ee8213d12ef8")).toBe(false);
  });

  it("rejects UUID with extra chars", () => {
    expect(isValidUuid("08cba264-d774-4afd-bc93-ee8213d12ef8x")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidUuid("08cba264-d774-4afd-bc93-ee8213d12xyz")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidIssueId
// ---------------------------------------------------------------------------

describe("isValidIssueId", () => {
  it("accepts standard Linear identifier like ENG-123", () => {
    expect(isValidIssueId("ENG-123")).toBe(true);
  });

  it("accepts lowercase Linear identifier like eng-456", () => {
    expect(isValidIssueId("eng-456")).toBe(true);
  });

  it("accepts single-letter prefix like A-1", () => {
    expect(isValidIssueId("A-1")).toBe(true);
  });

  it("accepts long prefix like PROJECT-99999", () => {
    expect(isValidIssueId("PROJECT-99999")).toBe(true);
  });

  it("accepts valid UUID", () => {
    expect(isValidIssueId("08cba264-d774-4afd-bc93-ee8213d12ef8")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidIssueId("")).toBe(false);
  });

  it("rejects plain number", () => {
    expect(isValidIssueId("12345")).toBe(false);
  });

  it("rejects string with spaces", () => {
    expect(isValidIssueId("ENG 123")).toBe(false);
  });

  it("rejects identifier starting with number", () => {
    expect(isValidIssueId("123-ABC")).toBe(false);
  });

  it("rejects identifier with only prefix (no number)", () => {
    expect(isValidIssueId("ENG-")).toBe(false);
  });

  it("rejects identifier with only number (no prefix)", () => {
    expect(isValidIssueId("-123")).toBe(false);
  });

  it("rejects random text", () => {
    expect(isValidIssueId("not an issue id")).toBe(false);
  });

  it("rejects identifier with special chars", () => {
    expect(isValidIssueId("ENG-123!")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidTeamId
// ---------------------------------------------------------------------------

describe("isValidTeamId", () => {
  it("accepts valid UUID", () => {
    expect(isValidTeamId("08cba264-d774-4afd-bc93-ee8213d12ef8")).toBe(true);
  });

  it("rejects non-UUID", () => {
    expect(isValidTeamId("team-1")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidTeamId("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sanitizeForPrompt
// ---------------------------------------------------------------------------

describe("sanitizeForPrompt", () => {
  it("escapes template variables", () => {
    const result = sanitizeForPrompt("Hello {{name}} world");
    expect(result).toBe("Hello { {escaped} } world");
  });

  it("escapes multiple template variables", () => {
    const result = sanitizeForPrompt("{{a}} and {{b}} and {{c}}");
    expect(result).toBe("{ {escaped} } and { {escaped} } and { {escaped} }");
  });

  it("truncates to maxLength", () => {
    const long = "x".repeat(5000);
    const result = sanitizeForPrompt(long, 100);
    expect(result.length).toBe(100);
  });

  it("uses default maxLength of 4000", () => {
    const long = "x".repeat(5000);
    const result = sanitizeForPrompt(long);
    expect(result.length).toBe(4000);
  });

  it("returns text unchanged when no templates and under limit", () => {
    const result = sanitizeForPrompt("Normal text with no templates");
    expect(result).toBe("Normal text with no templates");
  });

  it("handles empty string", () => {
    const result = sanitizeForPrompt("");
    expect(result).toBe("");
  });

  it("escapes before truncating (template at boundary)", () => {
    // Template at position that would be cut
    const text = "x".repeat(3998) + "{{y}}";
    const result = sanitizeForPrompt(text, 4000);
    // After escaping {{y}} → { {escaped} }, string becomes longer,
    // then truncation to 4000 chars applies
    expect(result.length).toBe(4000);
    expect(result).not.toContain("{{");
  });

  it("handles nested-looking braces", () => {
    const result = sanitizeForPrompt("{{{{deep}}}}");
    // The outer {{...}} matches "{{deep}}" first, inner {{ and }} are left
    expect(result).not.toContain("{{deep}}");
  });
});
