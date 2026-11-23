import { describe, it, expect } from "vitest";
import {
  decideRefundEligibility,
  REFUND_WATCH_LIMIT_SECONDS,
  type RefundEligibilityFacts,
} from "./refund-eligibility.server";
import { RefundStatus } from "~/db/schema";

const PURCHASED_AT = new Date(2026, 10, 1, 23, 0).toISOString();

function facts(overrides: Partial<RefundEligibilityFacts> = {}) {
  return {
    purchase: { id: 7, amountPaid: 4900, createdAt: PURCHASED_AT },
    hasOpenRefundRequest: false,
    refundStatuses: [],
    hasClaimedSeat: false,
    completedLessonCount: 0,
    totalLessonCount: 10,
    secondsWatched: 0,
    now: new Date(2026, 10, 3, 12, 0),
    ...overrides,
  } satisfies RefundEligibilityFacts;
}

describe("decideRefundEligibility", () => {
  it("offers the full amount paid on an eligible purchase", () => {
    expect(decideRefundEligibility(facts())).toEqual({
      eligible: true,
      purchaseId: 7,
      amount: 4900,
      lastDayInWindow: "2026-11-15",
    });
  });

  it("refuses a learner who has not bought the course", () => {
    expect(decideRefundEligibility(facts({ purchase: undefined }))).toMatchObject(
      { eligible: false, status: 403 }
    );
  });

  it("refuses a second request while one is still open", () => {
    expect(
      decideRefundEligibility(facts({ hasOpenRefundRequest: true }))
    ).toMatchObject({ eligible: false, status: 409 });
  });

  it("refuses a new request while the purchase has a Pending Refund", () => {
    expect(
      decideRefundEligibility(facts({ refundStatuses: [RefundStatus.Pending] }))
    ).toMatchObject({ eligible: false, status: 409 });
  });

  it("refuses a new request while the purchase has a Failed Refund", () => {
    expect(
      decideRefundEligibility(facts({ refundStatuses: [RefundStatus.Failed] }))
    ).toMatchObject({ eligible: false, status: 409 });
  });

  it("does not block a new request on an Issued Refund by this rule", () => {
    expect(
      decideRefundEligibility(facts({ refundStatuses: [RefundStatus.Issued] }))
    ).toMatchObject({ eligible: true });
  });

  it("allows a new request when past requests were only Declined", () => {
    expect(
      decideRefundEligibility(
        facts({ hasOpenRefundRequest: false, refundStatuses: [] })
      )
    ).toMatchObject({ eligible: true });
  });

  it("refuses a claimed team seat", () => {
    expect(
      decideRefundEligibility(facts({ hasClaimedSeat: true }))
    ).toMatchObject({ eligible: false, status: 403 });
  });

  it("still allows the whole fourteenth day, counted in calendar days", () => {
    expect(
      decideRefundEligibility(facts({ now: new Date(2026, 10, 15, 23, 59) }))
    ).toMatchObject({ eligible: true });
  });

  it("refuses once the fourteen-day window has closed", () => {
    expect(
      decideRefundEligibility(facts({ now: new Date(2026, 10, 16, 0, 1) }))
    ).toMatchObject({ eligible: false, status: 403 });
  });

  it("allows a learner who has completed just under half the lessons", () => {
    expect(
      decideRefundEligibility(facts({ completedLessonCount: 4 }))
    ).toMatchObject({ eligible: true });
  });

  it("refuses a learner who has completed half the lessons", () => {
    expect(
      decideRefundEligibility(facts({ completedLessonCount: 5 }))
    ).toEqual({
      eligible: false,
      reason: "You have completed too much of this course to request a refund.",
      status: 403,
    });
  });

  it("ignores completion for a course with no lessons", () => {
    expect(
      decideRefundEligibility(
        facts({ completedLessonCount: 0, totalLessonCount: 0 })
      )
    ).toMatchObject({ eligible: true });
  });

  it("refuses a learner who has watched two hours", () => {
    expect(
      decideRefundEligibility(
        facts({ secondsWatched: REFUND_WATCH_LIMIT_SECONDS })
      )
    ).toMatchObject({ eligible: false, status: 403 });
  });

  it("allows a learner just under two hours watched", () => {
    expect(
      decideRefundEligibility(
        facts({ secondsWatched: REFUND_WATCH_LIMIT_SECONDS - 1 })
      )
    ).toMatchObject({ eligible: true });
  });
});
