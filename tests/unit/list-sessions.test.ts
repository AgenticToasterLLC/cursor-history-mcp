import { beforeEach, describe, expect, it, vi } from "vitest";
import * as history from "cursor-history";
import { handleListSessions } from "../../src/tools/list-sessions.js";

vi.mock("cursor-history", async (importOriginal) => ({
  ...await importOriginal<typeof import("cursor-history")>(),
  listSessions: vi.fn(), listSessionSummaries: vi.fn(), getSession: vi.fn(),
}));

type Result = Awaited<ReturnType<typeof history.listSessionSummaries>>;

const resolved = {
  id: "ABCDEFAB-0000-0000-0000-000000000001", workspace: "/work/project", timestamp: "2025-01-01T00:00:00Z",
  createdAtSource: "composer-created-at", messageCount: 3, index: 4, indexScope: "workspace",
  source: "global", resolvedSource: "composer", resolutionState: "complete",
  title: "Fix login bug", preview: "ignored preview",
};
const ambiguous = {
  id: "ABCDEFAB-0000-0000-0000-000000000002", index: 5, indexScope: "workspace",
  resolutionState: "ambiguous", sourceRoles: ["global", "workspace"], occurrenceCount: 2,
  diagnosticOccurrenceRefs: ["r1", "r2"], canonicalWorkspacePath: "/work/project",
};

beforeEach(() => vi.resetAllMocks());

describe("handleListSessions", () => {
  it("uses summaries only and renders resolved, ambiguous rows and pagination", async () => {
    vi.mocked(history.listSessionSummaries).mockResolvedValue({
      data: [resolved, ambiguous],
      pagination: { total: 10, limit: 2, offset: 4, hasMore: true },
      diagnostics: [{ code: "SESSION_AMBIGUOUS", message: "divergent copies", sessionId: ambiguous.id }],
    } as unknown as Result);
    const out = await handleListSessions({ limit: 2, offset: 4, workspace: "/work/project" });
    expect(history.listSessionSummaries).toHaveBeenCalledTimes(1);
    expect(history.getSession).not.toHaveBeenCalled();
    expect(history.listSessions).not.toHaveBeenCalled();
    expect(out).toContain("#5 - project");
    expect(out).toContain("3 messages");
    expect(out).toContain('"Fix login bug..."');
    expect(out).toContain("Source: composer · Data: complete");
    expect(out).toContain("Index scope: workspace (/work/project)");
    expect(out).toContain("#6 -");
    expect(out).toContain(ambiguous.id);
    expect(out).toContain("Ambiguous: multiple divergent copies");
    expect(out).toContain("[SESSION_AMBIGUOUS]");
    expect(out).toContain("total=10 offset=4 limit=2 hasMore=true");
    expect(out).toContain("(4 more sessions available)");
  });

  it("handles an empty result", async () => {
    vi.mocked(history.listSessionSummaries).mockResolvedValue({
      data: [], pagination: { total: 0, limit: 20, offset: 0, hasMore: false },
    } as Result);
    expect(await handleListSessions({})).toBe("No Cursor chat sessions found.");
  });
});
