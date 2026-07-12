# Observability

Workers Logs emit JSON for `plan_created`, `plan_deleted`, `upload_rate_limited`, and `internal_error`. The same events are written to the `agent_html_plan_host_events` Analytics Engine dataset.

Dataset columns:

- `index1`: bearer-token hash, or `service` for non-token errors
- `blob1`: event name
- `blob2`: plan ID or request ID
- `double1`: HTML size in bytes
- `double2`: TTL in seconds
- `double3`: configured upload limit
- `double4`: retry delay in seconds

Query the dataset through Cloudflare's Analytics Engine SQL API. The following checks cover the operational signals required by the improvement plan.

## Events during the last hour

```sql
SELECT blob1 AS event, count() AS total
FROM agent_html_plan_host_events
WHERE timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY event
ORDER BY total DESC
```

## Internal errors

```sql
SELECT timestamp, blob2 AS request_id
FROM agent_html_plan_host_events
WHERE blob1 = 'internal_error'
  AND timestamp > NOW() - INTERVAL '1' HOUR
ORDER BY timestamp DESC
```

Alert when this query returns any rows. Use `request_id` to correlate the metric with Workers Logs.

## Rate-limit pressure

```sql
SELECT index1 AS token_hash, count() AS rejected
FROM agent_html_plan_host_events
WHERE blob1 = 'upload_rate_limited'
  AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY token_hash
ORDER BY rejected DESC
```

Alert when rejections exceed the expected agent workload. A sustained increase can indicate a retry loop or token abuse.
