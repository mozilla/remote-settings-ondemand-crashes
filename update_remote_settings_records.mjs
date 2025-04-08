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
import { readFile, readdir } from "node:fs/promises";
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

const IS_DRY_RUN = process.env.DRY_RUN == "1";
const COLLECTION_NAME = "crash-reports-ondemand"
const RS_COLLECTION_ENDPOINT = `${process.env.SERVER}/buckets/main-workspace/collections/${COLLECTION_NAME}`;
const RS_RECORDS_ENDPOINT = `${RS_COLLECTION_ENDPOINT}/records`;
const CRASH_PINGS_URL = "https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/mozilla.v2.process-top-crashes.latest.process-pings/artifacts/public/crash-ids.tar.gz";
const PROCESSES = ["gpu", "gmplugin", "rdd", "socket", "utility"];
const CHANNELS = ["nightly", "beta", "release"];

const HEADERS = {
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
  const { lastModified, data: previousRecords } = await getRSData();

  const crashIds = await getCrashIds(lastModified);

  if (!crashIds) {
    console.log(`No changes necessary: crash ids not modified since last update ✅`);
    return;
  }

  if (!await unpackTarball(crashIds)) {
    throw new Error('failed to unpack child-ids tarball');
  }

  const createdIds = new Set();
  for (const channel of CHANNELS) {
    for (const proc of PROCESSES) {
      for await (const topCrashers of getTopCrashersFor(channel, proc)) {
        for (const [sighash, {hashes, description}] of Object.entries(topCrashers)) {
          const recordId = `id-${String(createdIds.size).padStart(3, '0')}`;
          const rsDescription = `${proc} (${channel}): ${description}`;
          if (typeof description !== "string") {
            throw new Error(`malformed description data for ${proc} (${channel}) ${sighash}`);
          }
          if (hashes.some(v => typeof v !== "string")) {
            throw new Error(`malformed hashes data for ${proc} (${channel}) ${description}`);
          }
          await upsertRecord(recordId, rsDescription, hashes);
          createdIds.add(recordId);
        }
      }
    }
  }

  // Delete all extraneous records.
  for (const record of previousRecords) {
    if (!createdIds.has(record.id)) {
      await deleteRecord(record);
    }
  }

  console.log("Crash id lists synced ✅");
  await approveChanges();
}

async function getCrashIds(if_modified_since) {
  console.log(`Get crash ids from ${CRASH_PINGS_URL}`);
  const headers = new Headers();
  if (if_modified_since) {
    headers.append("If-Modified-Since", if_modified_since);
  }
  const response = await fetch(CRASH_PINGS_URL, {
    method: 'GET',
    headers
  });
  if (response.status === 304) {
    console.log(`Crash ids not modified since ${if_modified_since}`);
    return false;
  }
  require200(response, "Can't retrieve crash ids");

  return response.body;
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
        console.group("tar stdout");
        console.log(child.stdout.read().toString());
        console.groupEnd();
        console.group("tar stderr");
        console.log(child.stderr.read().toString());
        console.groupEnd();
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

async function checkStatus(response, expectedStatuses, errorMessage) {
  const successful = Array.isArray(expectedStatuses)
    ? expectedStatuses.includes(response.status)
    : response.status == expectedStatuses;
  if (!successful) {
    const body = await response.text();
    console.warn(
      `${errorMessage}: "[${response.status}] ${response.statusText}" ${body}`
    );
  }
  return successful;
}

async function* getTopCrashersFor(channel, process) {
  console.log(`Get top crashers for ${process} ${channel}`);
  // Some extra files exist (like for utility subprocesses), so read all files
  // matching the glob `crash-ids/${process}_${channel}*.json`.
  const files = (await readdir("crash-ids"))
    .filter(file => file.startsWith(`${process}_${channel}`) && file.endsWith(".json"))
    .map(file => `crash-ids/${file}`);
  for (const file of files) {
      try {
        yield JSON.parse(await readFile(file, { encoding: 'utf8' }));
      } catch (e) {
        console.warn(`failed to read ${file}: ${e}`);
        continue;
      }
  }
}

async function getRSData() {
  console.log(`Get existing data from ${RS_COLLECTION_ENDPOINT}`);
  const response = await fetch(RS_RECORDS_ENDPOINT, {
    method: "GET",
    headers: HEADERS,
  });
  require200(response, "Can't retrieve records");
  const lastModified = response.headers.get("Last-Modified");
  const { data } = await response.json();
  return { data, lastModified };
}

function dryRunnable(log, f) {
  return async function(...args) {
    if (IS_DRY_RUN) {
      console.log("[DRY_RUN]", ...(typeof log == "string" ? [log] : log(...args)));
      return true;
    } else {
      console.log(...(typeof log == "string" ? [log] : log(...args)));
    }
    return await f(...args);
  };
}

async function getLastModified() {
  console.log(`Get last modified time from ${RS_RECORDS_ENDPOINT}`);
  const response = await fetch(RS_RECORDS_ENDPOINT, {
    method: "HEAD",
    headers: HEADERS,
  });
  require200(response, "Can't retrieve last modified");
  return response.headers.get("Last-Modified") || false;
}

/**
 * Create a record on RemoteSettings
 *
 * @param {Object} browserMdn: An item from the result of getFlatBrowsersMdnData
 * @returns {Boolean} Whether the API call was successful or not
 */
const upsertRecord = dryRunnable(
  (description) => ["Create", description],
  async (recordId, description, hashes) => {
    const response = await fetch(`${RS_RECORDS_ENDPOINT}/${recordId}`, {
      method: "PUT",
      body: JSON.stringify({ data: { description, hashes } }),
      headers: HEADERS,
    });
    return await checkStatus(response, [200, 201], "Couldn't create record");
  },
);

/**
 * Remove a record on RemoteSettings
 *
 * @param {Object} record: The existing record on RemoteSettings
 * @returns {Boolean} Whether the API call was successful or not
 */
const deleteRecord = dryRunnable(
  (record) => ["Delete", record.id, record.description],
  async (record) => {
    const response = await fetch(`${RS_RECORDS_ENDPOINT}/${record.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    return await checkStatus(response, 200, "Couldn't delete record");
  },
);

/**
 * Remove all records on RemoteSettings
 *
 * @returns {Boolean} Whether the API call was successful or not
 */
const deleteAllRecords = dryRunnable("Delete all records", async () => {
  const response = await fetch(RS_RECORDS_ENDPOINT, {
    method: "DELETE",
    headers: HEADERS,
  });
  return await checkStatus(response, 200, "Couldn't delete all records");
});

const requestReview = dryRunnable("Requesting review", async () => {
  const response = await fetch(RS_COLLECTION_ENDPOINT, {
    method: "PATCH",
    body: JSON.stringify({ data: { status: "to-review" } }),
    headers: HEADERS,
  });
  if (await checkStatus(response, 200, "Couldn't request review")) {
    console.log("Review requested ✅");
  }
});

/**
 * Automatically approve changes made on the collection.
 * ⚠️ This only works on the `dev` server.
 */
const approveChanges = dryRunnable("Approving changes", async () => {
  const response = await fetch(RS_COLLECTION_ENDPOINT, {
    method: "PATCH",
    body: JSON.stringify({ data: { status: "to-sign" } }),
    headers: HEADERS,
  });
  if (await checkStatus(response, 200, "Couldn't approve changes")) {
    console.log("Changes approved ✅");
  }
});
