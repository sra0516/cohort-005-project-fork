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
  listRefundHistory,
  markRefundIssued,
  markRefundFailed,
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

describe("recording the payout of a Refund", () => {
  const CONFIRMED_AT = new Date("2026-11-22T15:30:00.000Z");

  function pendingRefund() {
    const request = raiseRefundRequest(7900);
    testDb
      .insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();
    const result = approveRefundRequest({
      refundRequestId: request.id,
      adminUserId: admin.id,
    });
    if (!result.ok) throw new Error("approval failed");
    return result.refund;
  }

  const issue = (refundId: number, internalNote?: string) =>
    markRefundIssued({
      refundId,
      adminUserId: admin.id,
      internalNote,
      now: CONFIRMED_AT,
    });
  const fail = (refundId: number, internalNote?: string) =>
    markRefundFailed({
      refundId,
      adminUserId: admin.id,
      internalNote,
      now: CONFIRMED_AT,
    });

  it("marks a Pending Refund Issued, recording who confirmed it and when", () => {
    const refund = pendingRefund();

    expect(issue(refund.id, "Paid by bank transfer")).toMatchObject({
      ok: true,
      refund: {
        id: refund.id,
        status: schema.RefundStatus.Issued,
        issuedAt: CONFIRMED_AT.toISOString(),
        issuedByUserId: admin.id,
        failedAt: null,
        failedByUserId: null,
        internalNote: "Paid by bank transfer",
      },
    });
  });

  it("marks a Pending Refund Failed with an Internal Note", () => {
    const refund = pendingRefund();

    expect(fail(refund.id, "Card expired")).toMatchObject({
      ok: true,
      refund: {
        status: schema.RefundStatus.Failed,
        failedAt: CONFIRMED_AT.toISOString(),
        failedByUserId: admin.id,
        issuedAt: null,
        issuedByUserId: null,
        internalNote: "Card expired",
      },
    });
  });

  it("marks a Failed Refund Issued once the payout succeeds, keeping the earlier note and who marked it Failed", () => {
    const refund = pendingRefund();
    const colleague = testDb
      .insert(schema.users)
      .values({
        name: "Cal Colleague",
        email: "cal@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    fail(refund.id, "Card expired");
    const ISSUED_AT = new Date("2026-11-23T09:00:00.000Z");

    expect(
      markRefundIssued({
        refundId: refund.id,
        adminUserId: colleague.id,
        internalNote: "Paid to new card",
        now: ISSUED_AT,
      })
    ).toMatchObject({
      ok: true,
      refund: {
        status: schema.RefundStatus.Issued,
        failedAt: CONFIRMED_AT.toISOString(),
        failedByUserId: admin.id,
        issuedAt: ISSUED_AT.toISOString(),
        issuedByUserId: colleague.id,
        internalNote: "Card expired\nPaid to new card",
      },
    });
  });

  it("rejects every other transition", () => {
    const failedTwice = pendingRefund();
    fail(failedTwice.id);
    expect(fail(failedTwice.id)).toMatchObject({ ok: false, status: 409 });

    const issued = pendingRefund();
    issue(issued.id);
    expect(issue(issued.id)).toMatchObject({ ok: false, status: 409 });
    expect(fail(issued.id)).toMatchObject({ ok: false, status: 409 });
  });

  it("reports an unknown Refund as not found", () => {
    expect(issue(9999)).toMatchObject({ ok: false, status: 404 });
    expect(fail(9999)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("listRefundHistory", () => {
  it("lists every decided Refund Request newest first, with its Refund and who did each step when", () => {
    const colleague = testDb
      .insert(schema.users)
      .values({
        name: "Cal Colleague",
        email: "cal@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    const declined = raiseRefundRequest(7900);
    const approved = raiseRefundRequest(4900);
    raiseRefundRequest(7900); // still Open, so not history

    declineRefundRequest({
      refundRequestId: declined.id,
      adminUserId: colleague.id,
      declineReason: "Outside the policy.",
      internalNote: "Fourth ask this year",
      now: new Date("2026-11-18T10:00:00.000Z"),
    });
    const approval = approveRefundRequest({
      refundRequestId: approved.id,
      adminUserId: admin.id,
      internalNote: "Goodwill",
      now: new Date("2026-11-19T10:00:00.000Z"),
    });
    if (!approval.ok) throw new Error("approval failed");
    markRefundFailed({
      refundId: approval.refund.id,
      adminUserId: admin.id,
      internalNote: "Card expired",
      now: new Date("2026-11-20T10:00:00.000Z"),
    });
    markRefundIssued({
      refundId: approval.refund.id,
      adminUserId: colleague.id,
      internalNote: "Paid to new card",
      now: new Date("2026-11-21T10:00:00.000Z"),
    });

    const learner = { id: base.user.id, name: "Test User", email: "test@example.com" };
    const course = { id: base.course.id, title: "Test Course", slug: "test-course" };

    expect(listRefundHistory()).toEqual([
      {
        id: approved.id,
        status: schema.RefundRequestStatus.Approved,
        reason: "The course was not for me.",
        requestedAt: approved.requestedAt,
        decidedAt: "2026-11-19T10:00:00.000Z",
        decidedBy: { id: admin.id, name: "Ada Admin" },
        declineReason: null,
        internalNote: "Goodwill",
        amountPaid: 4900,
        learner,
        course,
        refund: {
          id: approval.refund.id,
          amount: 4900,
          status: schema.RefundStatus.Issued,
          internalNote: "Card expired\nPaid to new card",
          failedAt: "2026-11-20T10:00:00.000Z",
          failedBy: { id: admin.id, name: "Ada Admin" },
          issuedAt: "2026-11-21T10:00:00.000Z",
          issuedBy: { id: colleague.id, name: "Cal Colleague" },
        },
      },
      {
        id: declined.id,
        status: schema.RefundRequestStatus.Declined,
        reason: "The course was not for me.",
        requestedAt: declined.requestedAt,
        decidedAt: "2026-11-18T10:00:00.000Z",
        decidedBy: { id: colleague.id, name: "Cal Colleague" },
        declineReason: "Outside the policy.",
        internalNote: "Fourth ask this year",
        amountPaid: 7900,
        learner,
        course,
        refund: null,
      },
    ]);
  });

  it("shows a Pending Refund with no confirmation steps yet", () => {
    const request = raiseRefundRequest();
    approveRefundRequest({ refundRequestId: request.id, adminUserId: admin.id });

    expect(listRefundHistory()[0].refund).toMatchObject({
      status: schema.RefundStatus.Pending,
      failedAt: null,
      failedBy: null,
      issuedAt: null,
      issuedBy: null,
    });
  });
});