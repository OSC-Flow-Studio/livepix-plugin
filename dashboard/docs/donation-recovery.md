# Donation recovery

Deploy the dashboard and LivePix plugin from the same recovery-capable build. Run
`npm run db:migrate` against the deployment database before starting the updated server,
then `npm run build`. The additive migration retains all deliveries and donations and
adds accounting receipt and resend audit fields.

The Donations panel searches local history by ID, reference, supporter or message. Its
native date/time input filters the local list and the provider history import. **Search
LivePix** reads messages and payments in bounded pages using the [official API](https://docs.livepix.gg/api).
Because the API does not document date ordering, traversal ends at an empty page, not at
the first older donation. Missing/invalid dates are counted as invalid and skipped.
Payment/message duplicates share the existing webhook/key constraint. No synthetic
webhook delivery is created for an imported donation; the normalized row retains the
provider's raw resource. Interrupted searches keep saved rows and can resume at the
failed page while the panel remains open. Reopening starts a safe deduplicated search.

| Endpoint | Authorization | Result |
| --- | --- | --- |
| `POST /api/webhooks/:id/donations/import` | Owner session | One page from LivePix, body `{since, resource: "messages" or "payments", page}`; counts and `hasMore` |
| `GET /api/webhooks/:id/donations?since=<ISO>&search=<text>&cursor=<rowId>` | Owner session | Saved donations, `accountedAt`, `lastResentAt`, `resendCount` |
| `POST /api/webhooks/:id/donations/:rowId/resend` | Owner session | `donation.replay` WebSocket message with the original donation and a new request ID |
| `POST /api/webhooks/:id/donations/recover` | Owner session | `donations.recover` WebSocket command; plugin reads its saved history from its configured start |
| `POST /:id/api/accounted` | Plugin token for that webhook | Idempotent receipt, body `{eventKey}` |

A replay endpoint returns `409 plugin_offline` when no socket accepted the send, and
`409 webhook_inactive` when the webhook is disabled. Offline commands are not queued.
HTTP success confirms a WebSocket send, not plugin execution or accounting. A first
`accountedAt` is stored only when the flow calls **Confirm accounting** after a successful
or duplicate **Register Donate** result. Never infer accounting from delivery status or
resend count. Receipts are historical evidence from the configured flow and are not
updated by later Subathon resets or manual corrections. Recovery does not skip receipts;
the downstream accounting ledger remains authoritative.

The plugin's start, amount and currency filters apply to every replay. Its recovery
command intentionally ignores this panel's list/search filters. It preserves the original
`eventKey`, so CatOPanda's durable ID ledger accepts only missing contributions. Keep that
ledger intact. Existing flows need the receipt block described in [the plugin guide](../../plugin/README.md#recovering-donations).

The server tests run against disposable PGlite with a fake provider and real HTTP/WS.
The cross-repository recovery scenario additionally loads the actual Studio flow engine
and both plugins when their sibling checkouts/builds are present; standalone checkouts
skip only that scenario. No real LivePix credentials are required.
