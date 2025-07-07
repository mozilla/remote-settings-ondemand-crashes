with
-- count reports per (signature, process_type, os, channel)
report_counts as (
    select
        signature,
        process_type,
        (case platform
            when 'Windows NT' then 'Windows'
            when 'Mac OS X' then 'Mac'
            else platform
        end) as os,
        release_channel as channel,
        COUNT(*) as report_count
    from moz-fx-data-shared-prod.telemetry.socorro_crash
    where TIMESTAMP(crash_date) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @report_interval_days DAY)
    group by all
),
-- gather unique (client, signature, process_type, channel) from pings
signature_single_client as (
    select
        client_info.client_id as client_id,
        signature,
        metrics.string.crash_process_type as process_type,
        crash_app_channel as channel,
        -- choose a single crash minidump for the client (disregard additional crashes with the same signature from the same client)
        ANY_VALUE(metrics.string.crash_minidump_sha256_hash) as minidump_hash,
        -- platform should be the same for any single client_id, so we can pick any
        ANY_VALUE((normalized_os, normalized_os_version, client_info.architecture)) as platform
    from moz-fx-data-shared-prod.crash_ping_ingest_external.ingest_output
    join moz-fx-data-shared-prod.telemetry.firefox_crashes using (document_id, submission_timestamp)
    where submission_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @ping_interval_days DAY)
    and signature != ""
    and signature != "EMPTY: no frame data available"
    group by all
),
-- count clients per (signature, process_type, channel, os) that have fewer than the minimum report threshold
underreported_signatures as (
    select
        a.signature,
        a.process_type,
        a.channel,
        a.platform[0] as os,
        COUNT(*) as client_count
    from signature_single_client as a
    left join report_counts as b
    on a.signature = b.signature
    and a.process_type = b.process_type
    and a.channel = b.channel
    and a.platform[0] = b.os
    where IFNULL(report_count, 0) < @report_minimum
    group by all
),
-- get the top crashing signatures (based on client count) for each (process_type, channel, os)
top_crashers_agg as (
    select
        ARRAY_AGG(signature order by client_count desc limit @top_crasher_count) as signatures,
        process_type,
        channel,
        os
    from underreported_signatures
    group by all
),
-- flatten top_crashers_agg signatures
top_crashers as (
    select
        signature, process_type, channel, os
    from top_crashers_agg
    join UNNEST(top_crashers_agg.signatures) as signature
),
-- group by platform to diversify selection when selecting hashes, in the hopes of getting more diverse reports (when applicable)
diverse_hashes as (
    select a.*, platform, ARRAY_AGG(minidump_hash limit @max_hashes_per_config) as minidump_hashes
    from top_crashers as a
    join signature_single_client as b
    on a.signature = b.signature
    and a.process_type = b.process_type
    and a.channel = b.channel
    and a.os = b.platform[0]
    where minidump_hash is not null
    group by all
),
-- flatten selected hashes to (signature, process_type, channel, os) groupings
all_hashes as (
    select signature, process_type, channel, os, ARRAY_CONCAT_AGG(minidump_hashes) as minidump_hashes
    from diverse_hashes
    group by all
)

-- sample max per top crasher hashes
select signature, process_type, channel, os, ARRAY(
        select *
        from UNNEST(minidump_hashes)
        where RAND() < @max_hashes_per_top_crasher / ARRAY_LENGTH(minidump_hashes)
        limit @max_hashes_per_top_crasher
    ) as minidump_hashes
from all_hashes
