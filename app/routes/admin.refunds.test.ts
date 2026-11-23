import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  userId: null as number | null,
}));
vi.mock("~/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("~/lib/session", () => ({
  getCurrentUserId: vi.fn(async () => holder.userId),
}));

import { loader, action } from "./admin.refunds";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let adminId: number;
let refundRequestId: number;

function callLoader() {
  return loader({
    request: new Request("http://localhost/admin/refunds"),
    params: {},
    context: {},
  } as Parameters<typeof loader>[0]);
}

function callAction(fields: Record<string, string>) {
  return action({
    request: new Request("http://localhost/admin/refunds", {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    params: {},
    context: {},
  } as Parameters<typeof action>[0]);
}

async function statusOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (thrown) {
    return (thrown as { init?: { status?: number } }).init?.status;
  }
  throw new Error("Expected the call to throw a response");
}

beforeEach(() => {
  testDb = createTestDb();
  holder.db = testDb;
  base = seedBaseData(testDb);
  adminId = testDb
    .insert(schema.users)
    .values({ name: "Ada", email: "ada@example.com", role: schema.UserRole.Admin })
    .returning()
    .get().id;
  const purchase = testDb
    .insert(schema.purchases)
    .values({ userId: base.user.id, courseId: base.course.id, amountPaid: 7900 })
    .returning()
    .get();
  refundRequestId = testDb
    .insert(schema.refundRequests)
    .values({ purchaseId: purchase.id, reason: "Not what I expected." })
    .returning()
    .get().id;
});

describe("/admin/refunds", () => {
  it.each([
    ["a learner", () => base.user.id],
    ["an instructor", () => base.instructor.id],
  ])("refuses %s with 403 on the screen and its actions", async (_, who) => {
    holder.userId = who();

    expect(await statusOf(callLoader())).toBe(403);
    expect(
      await statusOf(
        callAction({ intent: "approve", refundRequestId: String(refundRequestId) })
      )
    ).toBe(403);
    expect(
      await statusOf(
        callAction({
          intent: "decline",
          refundRequestId: String(refundRequestId),
          declineReason: "No.",
        })
      )
    ).toBe(403);
  });

  it("asks for a user when nobody is in the session", async () => {
    holder.userId = null;
    expect(await statusOf(callLoader())).toBe(401);
  });

  it("lets an admin see and approve an Open Refund Request", async () => {
    holder.userId = adminId;

    const before = await callLoader();
    expect(before.openRefundRequests.map((r) => r.id)).toEqual([refundRequestId]);

    await callAction({
      intent: "approve",
      refundRequestId: String(refundRequestId),
      internalNote: "",
    });

    const after = await callLoader();
    expect(after.openRefundRequests).toEqual([]);
  });

  it("tells an admin a Decline Reason is required", async () => {
    holder.userId = adminId;

    const result = await callAction({
      intent: "decline",
      refundRequestId: String(refundRequestId),
      declineReason: "",
    });

    expect(result).toMatchObject({ init: { status: 400 } });
    expect((await callLoader()).openRefundRequests).toHaveLength(1);
  });
});
