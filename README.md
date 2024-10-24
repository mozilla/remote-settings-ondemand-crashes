# `process-top-crashes` crash ids -> RemoteSettings 

The `process-top-crashes` dashboard outputs JSON files for top crasher ids. These ids should be
submitted to RemoteSettings for clients to upload the corresponding crash reports.

The script from this repo takes these lists of top crasher ids and:
- adds new records for top crashers which aren't yet on RemoteSettings, and
- removes any stale records which are no longer top crashers.

The top crashers are identified by a combination of process type and signature.
