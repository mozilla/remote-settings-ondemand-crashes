/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

// This script uses the following env variables:
// - AUTHORIZATION (mandatory): Raw authorization header (e.g. `AUTHORIZATION='Bearer XXXXXXXXXXXXX'`)
// - SERVER (mandatory): Writer server URL (eg. https://remote-settings.allizom.org/v1)
// - GOOGLE_APPLICATION_CREDENTIALS (mandatory): A path to a file with google credentials.
// - ENVIRONMENT (optional): "dev", "stage", or "prod".
// - DRY_RUN (optional): If set to 1, no changes will be made to the collection, this will
//                       only log the actions that would be done.
// - FORCE_UPDATE (optional): If set to 1, always update regardless of the last
//                            modification time.
//
// This script fetches crash ping signature data from bigquery and updates the
// RemoteSettings records to match the current top crashers.

import * as RS from "./remote_settings";
import SignatureData from "./signature_data";

async function main() {
  // Sanity check of environment variable inputs
  if (!process.env["AUTHORIZATION"]) {
    throw new Error('AUTHORIZATION environment variable needs to be set');
  }

  if (!process.env["SERVER"]) {
    throw new Error('SERVER environment variable needs to be set');
  }

  if (
    process.env["ENVIRONMENT"] &&
    !(RS.VALID_ENVIRONMENTS as readonly string[]).includes(process.env["ENVIRONMENT"])
  ) {
    throw new Error(
      `ENVIRONMENT environment variable needs to be set to one of the following values: ${RS.VALID_ENVIRONMENTS.join(", ")}`
    );
  }

  const forceUpdate = process.env["FORCE_UPDATE"] === "1";

  const rsUpdater = new RS.Updater({
    authorization: process.env["AUTHORIZATION"],
    server: process.env["SERVER"],
    environment: process.env["ENVIRONMENT"] as any, // verified above
    dry_run: process.env["DRY_RUN"] === "1",
  });
  const sigData = new SignatureData();

  const { data: previousRecords, lastModified } = await rsUpdater.getExistingRemoteData();

  if (!forceUpdate && lastModified && !await sigData.newDataSince(new Date(lastModified))) {
    console.log(`No changes necessary: crash ids not modified since last update (${lastModified}) ✅`);
    return;
  }

  const newData = await sigData.selectHashes();
  // Generate record ids arbitrarily to reuse records rather than create and
  // delete many on each update.
  let totalHashes = 0;
  const createdIds = new Set();
  for (const { signature, process_type, channel, os, minidump_hashes: hashes } of newData) {
    const recordId = `id-${String(createdIds.size).padStart(3, '0')}`;
    const description = `${process_type} (${os} ${channel}): ${signature}`;
    await rsUpdater.upsertRecord({ recordId, description, hashes });
    createdIds.add(recordId);
    totalHashes += hashes.length;
  }

  console.debug(`Selected ${totalHashes} hashes`);

  // Delete all extraneous records.
  for (const record of previousRecords) {
    if (!createdIds.has(record.id)) {
      await rsUpdater.deleteRecord(record);
    }
  }

  console.log("Crash id lists synced ✅");
  await rsUpdater.approveChanges();
}

if (import.meta.main) {
  try {
    await main();
  } catch (e: any) {
    console.error(e);
    process.exit(1);
  }
}
