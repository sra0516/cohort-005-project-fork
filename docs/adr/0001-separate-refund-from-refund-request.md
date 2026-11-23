# Separate the Refund from the Refund Request

The original `refunds` table actually held Refund Requests (the learner's ask and the team's decision), with the refunded amount bolted onto the same row. Once the money itself needed a lifecycle (Pending → Issued, or Failed and later Issued) that is independent of the decision, we renamed that table to `refund_requests` and added a new `refunds` table: one row per Approved Refund Request, carrying the amount, its own status, and who confirmed it and when. This keeps the code's names aligned with the glossary, and stops "approved" from being mistaken for "money sent".

## Considered Options

- **Add Refund status columns to the request row.** Rejected: it keeps the mismatch between the name `refunds` and what the table holds, and mixes two lifecycles in one status space (a Declined request would carry meaningless payout columns).

## Consequences

- No payment provider exists, so admins move a Refund from Pending to Issued or Failed by hand after paying out outside the app.
- Course access is removed only when the Refund is Issued, not when the request is approved.
