# Deployment Failure Runbook

For startup failures:

1. Check service logs around the reported time window.
2. Check health status for the failing service and adjacent services.
3. Compare production and staging configuration when staging is known good.
4. Prefer the smallest sandbox configuration change that removes the observed failure.
5. Validate the change before writing a handoff.

Do not delete state files or restart real host services during this benchmark.
