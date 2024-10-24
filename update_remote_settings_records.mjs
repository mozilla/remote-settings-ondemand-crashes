/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

// This script consumes the following env variables:
// - AUTHORIZATION (mandatory): Raw authorization header (e.g. `AUTHORIZATION='Bearer XXXXXXXXXXXXX'`)
// - SERVER (mandatory): Writer server URL (eg. https://remote-settings.allizom.org/v1)
// - ENVIRONMENT (optional): dev, stage, prod. When set to `dev`, the script will approve its own changes.
// - DRY_RUN (optional): If set to 1, no changes will be made to the collection, this will
//                       only log the actions that would be done.
// This node script fetches `https://crash-pings.mozilla.com/<process>_<channel>-crash-ids.json`
// files and updates the RemoteSettings records to match the current top
// crashers.

import fetch from "node-fetch";
import btoa from "btoa";

const SUCCESS_RET_VALUE = 0;
const FAILURE_RET_VALUE = 1;
const VALID_ENVIRONMENTS = ["dev", "stage", "prod"];

// Sanity check of environment variable inputs
if (!process.env.AUTHORIZATION) {
  console.error(`AUTHORIZATION environment variable needs to be set`);
  process.exit(FAILURE_RET_VALUE);
}

if (!process.env.SERVER) {
  console.error(
    `SERVER environment variable needs to be set`
  );
  process.exit(FAILURE_RET_VALUE);
}

if (
  process.env.ENVIRONMENT &&
  !VALID_ENVIRONMENTS.includes(process.env.ENVIRONMENT)
) {
  console.error(
    `ENVIRONMENT environment variable needs to be set to one of the following values: ${VALID_ENVIRONMENTS.join(
      ", "
    )}`
  );
  process.exit(FAILURE_RET_VALUE);
}

const isDryRun = process.env.DRY_RUN == "1";
const collectionName = "crash-reports-ondemand"
const rsCollectionEndpoint = `${process.env.SERVER}/buckets/main-workspace/collections/${collectionName}`;
const rsRecordsEndpoint = `${rsCollectionEndpoint}/records`;
const crashPings = "https://crash-pings.mozilla.com";
const processes = ["gpu", "gmplugin", "rdd", "socket", "utility"];
// Only use 'nightly' right now, for testing.
// const channels = ["nightly", "beta", "release"];
const channels = ["nightly"];

const headers = {
  "Content-Type": "application/json",
  Authorization: process.env.AUTHORIZATION.startsWith("Bearer ")
    ? process.env.AUTHORIZATION
    : `Basic ${btoa(process.env.AUTHORIZATION)}`,
}

update()
  .then(() => {
    return process.exit(SUCCESS_RET_VALUE);
  })
  .catch((e) => {
    console.error(e);
    return process.exit(FAILURE_RET_VALUE);
  });

async function update() {
  const records = await getRSRecords();

  const recordsByDescription = new Map(records.map(r => [r.description, r]));
  let changed = false;

  for (const channel of channels) {
    for (const proc of processes) {
      let topCrashers = {};
      try {
        topCrashers = await getTopCrashersFor(channel, proc);
      } catch (e) {
        console.warn(e);
        continue;
      }

      for (const [sighash, {hashes, description}] of Object.entries(topCrashers)) {
        const rsDescription = `${proc}: ${description}`;
        if (recordsByDescription.has(rsDescription)) {
          // Remove so the record remains in RemoteSettings.
          recordsByDescription.remove(rsDescription);
        } else {
          // Add a new record to RemoteSettings.
          await createRecord(rsDescription, hashes);
          changed = true;
        }
      }

      // Remove any records that are no longer top crashers.
      for (const record of Object.values(recordsByDescription)) {
        await deleteRecord(record.id);
        changed = true;
      }
    }
  }

  if (!changed) {
    console.log("No changes detected");
  } else {
    console.log("Crash id lists synced ✅");
    if (process.env.ENVIRONMENT === "dev") {
      // TODO do this for all environments (with approval)
      await approveChanges();
    }
  }
}

async function getTopCrashersFor(channel, process) {
  const jsonUrl = `${crashPings}/${process}_${channel}-crash-ids.json`;
  console.log(`Get top crashers from ${jsonUrl}`);

  const response = await fetch(jsonUrl);
  if (response.status !== 200) {
    throw new Error(
      `Can't retrieve top crashers: "[${response.status}] ${response.statusText}"`
    );
  }
  return await response.json();
}

async function getRSRecords() {
  console.log(`Get existing records from ${rsCollectionEndpoint}`);
  const response = await fetch(rsRecordsEndpoint, {
    method: "GET",
    headers,
  });
  if (response.status !== 200) {
    throw new Error(
      `Can't retrieve records: "[${response.status}] ${response.statusText}"`
    );
  }
  const { data } = await response.json();
  return data;
}

function dryRunnable(log, f) {
  return async function(...args) {
    console.log(isDryRun ? "[DRY_RUN] " : "", typeof log == "string" ? log : ...log(...args));
    if (isDryRun) {
      return true;
    }
    return await f(...args);
  };
}

/**
 * Create a record on RemoteSettings
 *
 * @param {Object} browserMdn: An item from the result of getFlatBrowsersMdnData
 * @returns {Boolean} Whether the API call was successful or not
 */
const createRecord = dryRunnable((description) => ["Create", description], async (description, hashes) => {
  const response = await fetch(`${rsRecordsEndpoint}`, {
    method: "POST",
    body: JSON.stringify({ data: {description, hashes} }),
    headers,
  });
  const successful = response.status == 201;
  if (!successful) {
    console.warn(
      `Couldn't create record: "[${response.status}] ${response.statusText}"`
    );
  }
  return successful;
};

/**
 * Remove a record on RemoteSettings
 *
 * @param {Object} record: The existing record on RemoteSettings
 * @returns {Boolean} Whether the API call was successful or not
 */
const deleteRecord = dryRunnable(record => ["Delete", record.description], async (record) => {
  const response = await fetch(`${rsRecordsEndpoint}/${record.id}`, {
    method: "DELETE",
    headers,
  });
  const successful = response.status == 200;
  if (!successful) {
    console.warn(
      `Couldn't delete record: "[${response.status}] ${response.statusText}"`
    );
  }
  return successful;
});

/**
 * Automatically approve changes made on the collection.
 * ⚠️ This only works on the `dev` server.
 */
const approveChanges = dryRunnable("Approving changes", async () => {
  const response = await fetch(rsCollectionEndpoint, {
    method: "PATCH",
    body: JSON.stringify({ data: { status: "to-sign" } }),
    headers,
  });
  if (response.status === 200) {
    console.log("Changes approved ✅");
  } else {
    console.warn(
      `Couldn't automatically approve changes: "[${response.status}] ${response.statusText}"`
    );
  }
});
