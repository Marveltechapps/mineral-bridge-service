# Business Logic Documentation

Source: `complete-integration-docs/08_Complete_Business_Logic.md`.

## Implemented

- Customer OTP signup/signin/decoy + registration token
- Suspension enforcement on authenticated customer requests
- Staff `requireAction` with role defaults + module fallback
- Buy order create **without** stock reservation (doc 08 D.5); reservation on admin `accepted` step
- Quotation issue (admin) / accept / decline (customer)
- E-contract draft + customer sign (name + hash) + staff countersign
- Payment submit (bank/UPI/BTC manual) + finance confirm/reject
- Delivery receipt / discrepancy; free cancellation before payment
- Sell request create + seller form + inspection accept/query
- Outbox enqueue + worker → in-app notifications + SSE fan-out

## Partial / pending

- Auction winner → order, refunds, price variations, change-request holds, issued document PDFs
- Full payout release four-eyes, partner directory CRUD
- Provider-backed BTC rates and SMS/email delivery beyond configured integrations
