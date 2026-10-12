# Four-minute walkthrough

This walkthrough uses the running local service and synthetic data. Do not use client payloads or production credentials in a recorded portfolio demonstration.

## 0:00 — Explain the problem

“A webhook receiver can be temporarily unavailable, and producers can resend events when acknowledgements are lost. RelayDesk records accepted work, handles repeated event IDs explicitly, and shows what happened on every delivery attempt.”

Start with `npm ci` and `npm run dev`. Open `http://localhost:3000` and enter `sample-admin-key-change-me`. The displayed rows and counts come from the database.

## 0:30 — Send signed events

In another terminal, run:

```sh
npm run demo
```

The script signs actual HTTP requests and checks the response to an identical event and to a changed payload under the same ID. It also verifies retry and recovery behavior, automatically repairing and replaying its permanent-failure example before finishing. Explain why signature verification uses raw body bytes while duplicate detection uses canonical JSON.

The transient example fails twice with 503 before delivery succeeds. Select its row and inspect the attempt history rather than merely reporting a green status. Then click **Run demo scenario** to create a fresh set of events for the manual recovery demonstration.

## 1:30 — Recover a permanent failure

Find the synthetic permanent-failure delivery. Its receiver returns 422, so it becomes dead without waiting through a budget of temporary retries.

Choose **Fix demo receiver & replay** in the detail view. It repairs the synthetic receiver condition and replays that dead delivery together. Observe the new generation and the preserved earlier failed attempt. The ordinary **Replay delivery** action only requeues work; it does not repair the receiver. Explain that replay is intentional work after the downstream issue has been corrected, not a button that silently removes evidence of failure.

## 2:30 — Explain restart and worker safety

Show that `data/relaydesk.sqlite` is a real persisted database, excluded from Git. Restarting the process preserves deliveries and their audit history. The synthetic receiver's fault counters and recovery flags are deliberately in memory and reset on restart; they are demo behavior, not a durable downstream business system.

Discuss the harder case: a worker may have sent a request before it died. An expired lease lets work resume, and token fencing prevents a stale completion from overwriting the recovered state. Neither can prove whether the receiver already performed its action. A receiver needs to deduplicate the stable delivery ID.

Do not imply that a normal restart demonstration alone verifies every crash window. The automated tests cover lease recovery and stale completion; the architecture notes explain the network acknowledgement gap.

## 3:15 — Show verification and limits

```sh
npm run check
npm run test:coverage
```

Show real command results. Point to tests for signature rejection, duplicate/conflict handling, retry bounds, lease ownership, and replay rather than claiming a test count or percentage before checking the current output.

Finish with the deployment boundary: this is a bounded, single-service reference implementation. A real client deployment needs its authentication, egress rules, secrets, retention, backup, and monitoring decisions made explicitly.

## A concise interview explanation

“I chose webhook delivery because it exposes the important backend tradeoffs in a small runnable project. The durable intake transaction handles producer resends, the worker lease handles recovery, and the audit history makes failures understandable. I deliberately call the semantics at-least-once, because a network acknowledgement can be lost after the receiver has acted. The receiver still needs idempotency.”

This is an independent project built with AI assistance. Describe only the behavior you can demonstrate and explain. Do not present it as a previous employer's system or a client production deployment.
