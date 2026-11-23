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
vi.mock("~/lib/country.server", () => ({
  resolveCountry: vi.fn(async () => null),
}));

import { getAccess } from "./access.server";
import {
  approveRefundRequest,
  markRefundFailed,
  markRefundIssued,
} from "./refund-decisions.server";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let adminId: number;
let lessonId: number;

function accessToCourse() {
  return getAccess(new Request("http://localhost/"), base.course.id);
}

function buyCourse() {
  const purchase = testDb
    .insert(schema.purchases)
    .values({ userId: base.user.id, courseId: base.course.id, amountPaid: 7900 })
    .returning()
    .get();
  testDb
    .insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();
  return purchase;
}

function approvedRefund(purchaseId: number) {
  const request = testDb
    .insert(schema.refundRequests)
    .values({ purchaseId, reason: "Not for me." })
    .returning()
    .get();
  const result = approveRefundRequest({
    refundRequestId: request.id,
    adminUserId: adminId,
  });
  if (!result.ok) throw new Error("approval failed");
  return result.refund;
}

beforeEach(() => {
  testDb = createTestDb();
  holder.db = testDb;
  base = seedBaseData(testDb);
  holder.userId = base.user.id;
  adminId = testDb
    .insert(schema.users)
    .values({ name: "Ada", email: "ada@example.com", role: schema.UserRole.Admin })
    .returning()
    .get().id;
  const module = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  lessonId = testDb
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson 1", position: 1 })
    .returning()
    .get().id;
});

describe("access after a Refund", () => {
  it("keeps access while the Refund is Pending or Failed", async () => {
    const refund = approvedRefund(buyCourse().id);
    expect((await accessToCourse()).canViewContent).toBe(true);

    markRefundFailed({ refundId: refund.id, adminUserId: adminId });
    expect((await accessToCourse()).canViewContent).toBe(true);
  });

  it("ends access once the Refund is Issued, keeping progress and watch history", async () => {
    const refund = approvedRefund(buyCourse().id);
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId,
        status: schema.LessonProgressStatus.Completed,
      })
      .run();
    testDb
      .insert(schema.videoWatchEvents)
      .values({ userId: base.user.id, lessonId, eventType: "progress", positionSeconds: 60 })
      .run();

    markRefundIssued({ refundId: refund.id, adminUserId: adminId });

    expect(await accessToCourse()).toMatchObject({
      enrolled: false,
      canViewContent: false,
    });
    expect(testDb.select().from(schema.lessonProgress).all()).toHaveLength(1);
    expect(testDb.select().from(schema.videoWatchEvents).all()).toHaveLength(1);
  });

  it("does not let a refunded purchase grant access even if an enrollment remains", async () => {
    const refund = approvedRefund(buyCourse().id);
    markRefundIssued({ refundId: refund.id, adminUserId: adminId });
    testDb
      .insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();

    expect((await accessToCourse()).canViewContent).toBe(false);
  });

  it("ends access even when an earlier Refund Request on the purchase was Declined", async () => {
    const purchase = buyCourse();
    testDb
      .insert(schema.refundRequests)
      .values({
        purchaseId: purchase.id,
        reason: "First try.",
        status: schema.RefundRequestStatus.Declined,
        declineReason: "Outside the policy.",
      })
      .run();
    const refund = approvedRefund(purchase.id);
    markRefundIssued({ refundId: refund.id, adminUserId: adminId });
    testDb
      .insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();

    expect((await accessToCourse()).canViewContent).toBe(false);
  });

  it("restores access when the learner buys the course again", async () => {
    const refund = approvedRefund(buyCourse().id);
    markRefundIssued({ refundId: refund.id, adminUserId: adminId });

    buyCourse();

    expect(await accessToCourse()).toMatchObject({
      enrolled: true,
      canViewContent: true,
    });
  });
});
