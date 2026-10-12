# Portfolio publication copy

## Repository description

TypeScript webhook delivery service with signed intake, a SQLite queue, bounded retries, dead-letter replay, lease recovery, and an operations dashboard.

**Public repository:** [github.com/kaveh981/relaydesk](https://github.com/kaveh981/relaydesk)

## Profile project title

RelayDesk — Durable Webhook Delivery and Recovery

## Profile description

Independent TypeScript/Node.js reference project for API integration reliability. RelayDesk verifies signed webhook requests, accepts immutable event IDs atomically, queues delivery in SQLite, and records each attempt. An operations dashboard shows retry schedules, failures, and replay history. Worker leases and token fencing protect queue state during recovery; receiver-side idempotency remains necessary for at-least-once delivery. Includes a runnable synthetic HTTP demo, automated tests, architecture notes, and CI configuration. Built with AI assistance; contains no client code or client deployment claims.

## Application paragraph

My public sample, [RelayDesk](https://github.com/kaveh981/relaydesk), demonstrates how I approach backend integration work: signed HTTP intake, explicit duplicate and conflict handling, durable state, bounded retries, and clear operational recovery. It includes a runnable synthetic demo and tests so you can inspect behavior rather than rely on a feature list. I can walk through the tradeoffs and adapt the approach to a defined integration requirement after reviewing your system.

## Suggested repository topics

`typescript`, `nodejs`, `fastify`, `webhooks`, `sqlite`, `api-integration`, `idempotency`, `retry`, `portfolio`

## Publication checks

Before sharing the public URL, verify the latest local checks and the first GitHub CI run, confirm that only synthetic content is tracked, and inspect the screenshot for keys or personal data. The MIT license permits broad reuse; the copyright notice names Kaveh Fereidouni.

This file prepares copy. It does not publish a freelance service, send an application, or claim that a GitHub CI run has passed.
