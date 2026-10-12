# Repository conventions

- This is an independent public reference project. Use only synthetic data and public example secrets. Keep real credentials, databases, client code and private operational records outside the repository.
- Preserve atomic event acceptance and delivery creation, immutable event identity, bounded retries, lease fencing and audit history across replay.
- Delivery is at least once. Never claim exactly-once processing; document receiver-side idempotency requirements.
- Verify the exact request bytes before parsing signed webhook bodies. Keep inbound, outbound and administrator secrets separate.
- Run `npm run check` for changes and meaningful failure-path tests for affected behavior. The signed HTTP demonstration requires the local service to be running.
- Keep the README and walkthrough aligned with actual configuration and response shapes. Do not claim deployment, CI, performance or coverage results without corresponding evidence.
