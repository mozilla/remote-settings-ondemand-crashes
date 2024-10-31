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

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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
const crashPings = "https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/mozilla.v2.process-top-crashes.latest.process-pings/artifacts/public/crash-ids.tar.gz";
const processes = ["gpu", "gmplugin", "rdd", "socket", "utility"];
const channels = ["nightly", "beta", "release"];

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
  const sourceLastModified = await getSourceLastModified();
  const crashIds = await getCrashIds(sourceLastModified);

  if (!crashIds) {
    console.log(`No changes necessary: crash ids not modified since last update ✅`);
    return;
  }

  const { body, last_modified } = crashIds;
  if (!await unpackTarball(body)) {
    throw new Error('failed to unpack child-ids tarball');
  }

  await deleteAllRecords();

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
        const rsDescription = `${proc} (${channel}): ${description}`;
        await createRecord(rsDescription, hashes);
      }
    }
  }

  await putSourceLastModified(last_modified);

  console.log("Crash id lists synced ✅");
  if (process.env.ENVIRONMENT === "dev") {
    // TODO do this for all environments (with approval)
    await approveChanges();
  } else {
    await requestReview();
  }
}

async function getCrashIds(if_modified_since) {
  console.log(`Get crash ids from ${crashPings}`);
  const headers = new Headers();
  if (if_modified_since) {
    headers.append("If-Modified-Since", if_modified_since);
  }
  const response = await fetch(crashPings, {
    method: 'GET',
    headers
  });
  if (response.status === 304) {
    console.log(`Crash ids not modified since ${if_modified_since}`);
    return false;
  }
  require200(response, "Can't retrieve crash ids");

  return {
    body: response.body,
    last_modified: response.headers.get("Last-Modified"),
  };
}

async function unpackTarball(readableStream) {
  console.log("Unpacking child ids tarball");
  const child = spawn("tar", ["-xzf", "-"]);
  readableStream.pipe(child.stdin);
  return await new Promise((resolve) => {
    child.on('close', code => {
      const success = code === 0;
      if (!success) {
        console.log(`tar exited with error code ${code}`);
      }
      resolve(success);
    });
  });
}

function require200(response, context) {
  if (response.status !== 200) {
    throw new Error(
      `${context}: "[${response.status}] ${response.statusText}"`
    );
  }
}

async function getTopCrashersFor(channel, process) {
  const path = `crash-ids/${process}_${channel}.json`;
  console.log(`Get top crashers from ${path}`);
  return JSON.parse(await readFile(path, { encoding: 'utf8' }));
}

async function getRSRecords() {
  console.log(`Get existing records from ${rsCollectionEndpoint}`);
  const response = await fetch(rsRecordsEndpoint, {
    method: "GET",
    headers,
  });
  require200(response, "Can't retrieve records");
  const { data } = await response.json();
  return data;
}

function dryRunnable(log, f) {
  return async function(...args) {
    if (isDryRun) {
      console.log("[DRY_RUN]", ...(typeof log == "string" ? [log] : log(...args)));
      return true;
    } else {
      console.log(...(typeof log == "string" ? [log] : log(...args)));
    }
    return await f(...args);
  };
}

async function getSourceLastModified() {
  console.log(`Get source_last_modified time from ${rsCollectionEndpoint}`);
  const response = await fetch(rsCollectionEndpoint, {
    method: "GET",
    headers,
  });
  require200(response, "Can't retrieve source_last_modified");
  const { data } = await response.json();
  return data.source_last_modified || false;
}

const putSourceLastModified = dryRunnable(time => ["Set source_last_modified to ", time], async (source_last_modified) => {
  const response = await fetch(rsCollectionEndpoint, {
    method: "PATCH",
    body: JSON.stringify({ data: { source_last_modified } }),
    headers,
  });
  const successful = response.status == 200;
  if (!successful) {
    console.warn(
      `Couldn't set source_last_modified: "[${response.status}] ${response.statusText}"`
    );
  }
  return successful;
});

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
});

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
 * Remove all records on RemoteSettings
 *
 * @returns {Boolean} Whether the API call was successful or not
 */
const deleteAllRecords = dryRunnable("Delete all records", async () => {
  const response = await fetch(rsRecordsEndpoint, {
    method: "DELETE",
    headers,
  });
  const successful = response.status == 200;
  if (!successful) {
    console.warn(
      `Couldn't delete all records: "[${response.status}] ${response.statusText}"`
    );
  }
  return successful;
});

const requestReview = dryRunnable("Requesting review", async () => {
  const response = await fetch(rsCollectionEndpoint, {
    method: "PATCH",
    body: JSON.stringify({ data: { status: "to-review" } }),
    headers,
  });
  if (response.status === 200) {
    console.log("Review requested ✅");
  } else {
    console.warn(
      `Couldn't request review: "[${response.status}] ${response.statusText}"`
    );
  }
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
