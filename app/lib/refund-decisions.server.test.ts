import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("~/db", () => ({
  get db() {
    return holder.db;
  },
}));

import {
  approveRefundRequest,
  declineRefundRequest,
  listOpenRefundRequests,
} from "./refund-decisions.server";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let admin: typeof schema.users.$inferSelect;

const DECIDED_AT = new Date("2026-11-20T10:00:00.000Z");

function raiseRefundRequest(amountPaid = 7900) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid,
      createdAt: "2026-11-15T09:00:00.000Z",
    })
    .returning()
    .get();
  return testDb
    .insert(schema.refundRequests)
    .values({ purchaseId: purchase.id, reason: "The course was not for me." })
    .returning()
    .get();
}

beforeEach(() => {
  testDb = createTestDb();
  holder.db = testDb;
  base = seedBaseData(testDb);
  admin = testDb
    .insert(schema.users)
    .values({
      name: "Ada Admin",
      email: "admin@example.com",
      role: schema.UserRole.Admin,
    })
    .returning()
    .get();
});

describe("approveRefundRequest", () => {
  it("approves an Open Refund Request and creates a Pending Refund for the full amount paid", () => {
    const request = raiseRefundRequest(7900);

    const result = approveRefundRequest({
      refundRequestId: request.id,
      adminUserId: admin.id,
      internalNote: "Goodwill",
      now: DECIDED_AT,
    });

    expect(result).toMatchObject({
      ok: true,
      refundRequest: {
        status: schema.RefundRequestStatus.Approved,
        decidedAt: DECIDED_AT.toISOString(),
        decidedByUserId: admin.id,
        internalNote: "Goodwill",
        declineReason: null,
      },
      refund: {
        refundRequestId: request.id,
        amount: 7900,
        status: schema.RefundStatus.Pending,
      },
    });
  });
});

describe("declineRefundRequest", () => {
  it("declines an Open Refund Request with a Decline Reason and no Refund", () => {
    const request = raiseRefundRequest();

    const result = declineRefundRequest({
      refundRequestId: request.id,
      adminUserId: admin.id,
      declineReason: "You have watched most of the course.",
      now: DECIDED_AT,
    });

    expect(result).toEqual({
      ok: true,
      refundRequest: expect.objectContaining({
        status: schema.RefundRequestStatus.Declined,
        declineReason: "You have watched most of the course.",
        internalNote: null,
        decidedAt: DECIDED_AT.toISOString(),
        decidedByUserId: admin.id,
      }),
    });
  });

  it("refuses to decline without a Decline Reason", () => {
    const request = raiseRefundRequest();

    expect(
      declineRefundRequest({
        refundRequestId: request.id,
        adminUserId: admin.id,
        declineReason: "   ",
        internalNote: "Suspicious",
      })
    ).toMatchObject({ ok: false, status: 400 });
  });
});

describe("listOpenRefundRequests", () => {
  function addLessons(count: number) {
    const module = testDb
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Basics", position: 1 })
      .returning()
      .get();
    return Array.from({ length: count }, (_, i) =>
      testDb
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${i + 1}`, position: i })
        .returning()
        .get()
    );
  }

  it("shows each Open Refund Request with the learner's eligibility facts as they stand now", () => {
    const [first, second, third] = addLessons(4);
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId: first.id,
        status: schema.LessonProgressStatus.Completed,
      })
      .run();
    testDb
      .insert(schema.videoWatchEvents)
      .values([
        { userId: base.user.id, lessonId: second.id, eventType: "progress", positionSeconds: 600 },
        { userId: base.user.id, lessonId: second.id, eventType: "progress", positionSeconds: 3600 },
        { userId: base.user.id, lessonId: third.id, eventType: "progress", positionSeconds: 1800 },
      ])
      .run();
    const request = raiseRefundRequest(7900);

    expect(
      listOpenRefundRequests(new Date("2026-11-20T12:00:00.000Z"))
    ).toEqual([
      {
        id: request.id,
        reason: "The course was not for me.",
        requestedAt: request.requestedAt,
        learner: { id: base.user.id, name: "Test User", email: "test@example.com" },
        course: { id: base.course.id, title: "Test Course", slug: "test-course" },
        purchase: { amountPaid: 7900, purchasedAt: "2026-11-15T09:00:00.000Z" },
        facts: {
          daysSincePurchase: 5,
          percentLessonsCompleted: 25,
          hoursWatched: 1.5,
        },
      },
    ]);
  });

  it("leaves out Refund Requests that have been decided", () => {
    const approved = raiseRefundRequest();
    const declined = raiseRefundRequest();
    const open = raiseRefundRequest();
    approveRefundRequest({ refundRequestId: approved.id, adminUserId: admin.id });
    declineRefundRequest({
      refundRequestId: declined.id,
      adminUserId: admin.id,
      declineReason: "Outside the policy.",
    });

    expect(listOpenRefundRequests().map((r) => r.id)).toEqual([open.id]);
  });
});

describe("a decided Refund Request is final", () => {
  const decline = (refundRequestId: number) =>
    declineRefundRequest({
      refundRequestId,
      adminUserId: admin.id,
      declineReason: "Outside the policy.",
    });
  const approve = (refundRequestId: number) =>
    approveRefundRequest({ refundRequestId, adminUserId: admin.id });

  it("cannot be approved twice", () => {
    const request = raiseRefundRequest();
    approve(request.id);
    expect(approve(request.id)).toMatchObject({ ok: false, status: 409 });
  });

  it("cannot be declined once approved", () => {
    const request = raiseRefundRequest();
    approve(request.id);
    expect(decline(request.id)).toMatchObject({ ok: false, status: 409 });
  });

  it("cannot be approved once declined", () => {
    const request = raiseRefundRequest();
    decline(request.id);
    expect(approve(request.id)).toMatchObject({ ok: false, status: 409 });
  });

  it("reports an unknown Refund Request as not found", () => {
    expect(approve(9999)).toMatchObject({ ok: false, status: 404 });
    expect(decline(9999)).toMatchObject({ ok: false, status: 404 });
  });
});
