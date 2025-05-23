# Select minidump hashes for on-demand crash reports and insert into Remote Settings

This queries BigQuery to determine which signatures are the per-client top-crashers for each
process-type/channel/os combination which are under-reported on
[https://crash-stats.mozilla.org](https://crash-stats.mozilla.org). It then tries to choose a
diverse set of crashes for each signature (based on client platforms) and aggregates a set of
minidump hashes for which we are interested in getting reports.

The selected hashes are updated in RemoteSettings, reusing record slots to avoid constant
creation/destruction of records.

## Environment
See the comments at the start of [main.ts](src/main.ts) which describe the environment variables
which influence this script.
