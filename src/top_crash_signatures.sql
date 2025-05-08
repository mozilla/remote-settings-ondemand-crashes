with
-- count reports per (signature, process_type, channel)
report_counts as (
    select
        signature,
        process_type,
        release_channel as channel,
        COUNT(*) as report_count
    from telemetry.socorro_crash
    where TIMESTAMP(crash_date) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @report_interval_days DAY)
    group by all
),
-- gather unique (client, signature, process_type, channel) from pings
signature_single_client as (
    select
        client_info.client_id as client_id,
        signature,
        metrics.string.crash_process_type as process_type,
        metrics.string.crash_app_channel as channel,
        -- choose a single crash minidump for the client (disregard additional crashes with the same signature from the same client)
        ANY_VALUE(metrics.string.crash_minidump_sha256_hash) as minidump_hash,
        -- os and arch should be the same for any single client_id, so we can pick any
        ANY_VALUE((normalized_os, normalized_os_version, client_info.architecture)) as platform
    from moz-fx-data-shared-prod.crash_ping_ingest_external.ingest_output
    join firefox_desktop.desktop_crashes using (document_id, submission_timestamp)
    where submission_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @ping_interval_days DAY)
    and signature != ""
    and signature != "EMPTY: no frame data available"
    group by all
),
-- count clients per (signature, process_type, channel) that have fewer than the minimum report threshold
underreported_signatures as (
    select
        signature,
        process_type,
        channel,
        COUNT(*) as client_count
    from signature_single_client
    left join report_counts using (signature, process_type, channel)
    where IFNULL(report_count, 0) < @report_minimum
    group by all
),
-- get the top crashing signatures (based on client count) for each (process_type, channel)
top_crashers_agg as (
    select
        ARRAY_AGG(signature order by client_count desc limit @top_crasher_count) as signatures,
        process_type,
        channel
    from underreported_signatures
    group by all
),
-- flatten top crashers_agg signatures
top_crashers as (
    select
        signature, process_type, channel
    from top_crashers_agg
    join UNNEST(top_crashers_agg.signatures) as signature
),
-- group by platform to diversify selection when selecting hashes, in the hopes of getting more diverse reports (when applicable)
diverse_hashes as (
    select top_crashers.*, platform, ARRAY_AGG(minidump_hash limit @max_hashes_per_config) as minidump_hashes
    from top_crashers
    join signature_single_client using (signature, process_type, channel)
    where minidump_hash is not null
    group by all
)

-- flatten selected hashes to (signature, process_type, channel) groupings
select signature, process_type, channel, ARRAY_CONCAT_AGG(minidump_hashes) as minidump_hashes
from diverse_hashes
group by all
