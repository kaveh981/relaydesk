# Verification record

Verified locally on **13 October 2026**. This records checks performed on this reference project, not client deployment results or a throughput benchmark.

| Check                                 | Result                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript build, ESLint and Prettier | Passed                                                                                                                                                                                                                    |
| Automated tests, Node 26.3.0          | 74 passed across six files                                                                                                                                                                                                |
| Automated tests, Node 24.21.0         | 74 passed across six files                                                                                                                                                                                                |
| V8 coverage, Node 26                  | 92.72% statements, 89.54% branches; configured thresholds passed                                                                                                                                                          |
| Signed HTTP demo (`npm run demo`)     | Passed: duplicate suppression, conflicting payload rejection, protected admin API, actual HTTP delivery, two transient failures then success, permanent failure then replay with stable delivery ID and preserved history |
| Browser walkthrough                   | Connected, ran scenario, inspected retry timeline, repaired synthetic receiver and replayed dead delivery; history retained both cycles                                                                                   |
| Narrow layout check                   | At a 390px viewport, document width was 390px with no horizontal page overflow                                                                                                                                            |
| Dependency audit during installation  | No known vulnerabilities reported by npm at that time                                                                                                                                                                     |
| Docker execution                      | Not run; Docker was unavailable                                                                                                                                                                                           |
| GitHub CI                             | Configured; not run before publication                                                                                                                                                                                    |

The screenshot in the README is captured from the actual local service with synthetic records. It shows a successful retry sequence and a separate delivery awaiting recovery. Demo receiver fault counters are intentionally in memory; the queue and attempt history are persisted in SQLite.

Rerun `npm run check`, `npm run test:coverage` and the signed demo to reproduce the application checks. Counts and coverage will change when tests or source change. CI status must be checked independently after publishing.
