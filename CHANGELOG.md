# Changelog

## Unreleased

## v1.1.4 - 2025-04-08
- Re-use record slots to avoid a ton of churn deleting and adding new records in remote settings.

## v1.1.3 - 2024-12-02
- Verify crash-id data and fail if it's not what's expected (otherwise the server will fail when
  validating).
- Log response bodies when non-fatal errors occur.

## v1.1.2 - 2024-11-08
- Run the application as a user with permissions to the `/app` directory.
- Write tar stdout/stderr to stdout on error.

## v1.1.1 - 2024-11-08
- Use node 23 in the docker file.

## v1.1.0 - 2024-11-07
- Read crash id files with arbitrary suffixes to support utility ipc actor files.
- Always approve changes (no need for dual sign-off). See bug 1927189.

## v1.0.0 - 2024-11-04
- Initial release.
