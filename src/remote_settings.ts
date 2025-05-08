/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

export const VALID_ENVIRONMENTS = Object.freeze(["dev", "stage", "prod"] as const);
const COLLECTION_NAME = "crash-reports-ondemand";

export type Config = {
  authorization: string,
  server: string,
  environment?: typeof VALID_ENVIRONMENTS[number],
  dry_run?: boolean,
};

function require200(response: Response, error: string) {
  if (response.status !== 200) {
    throw new Error(
      `${error}: "[${response.status}] ${response.statusText}"`
    );
  }
}

async function checkStatus(response: Response, expectedStatuses: number[] | number, errorMessage: string) {
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

export type RSRecord = {
  id: string,
  description: string,
};

export class Updater {
  readonly collectionEndpoint: string;
  readonly headers: Record<string, string>;
  readonly dryRun: boolean = false;

  get recordsEndpoint() {
    return `${this.collectionEndpoint}/records`;
  }

  constructor(config: Config) {
    this.collectionEndpoint = `${config.server}/buckets/main-workspace/collections/${COLLECTION_NAME}`;
    this.headers = {
      "Content-Type": "application/json",
      "Authorization": config.authorization.startsWith("Bearer ") ? config.authorization : `Basic ${btoa(config.authorization)}`,
    };
    this.dryRun = config.dry_run ?? false;
  }

  /**
   * Get the existing records and the last modification time (if any).
   */
  async getExistingRemoteData(): Promise<{ data: RSRecord[], lastModified?: string }> {
    console.log(`Get existing data from ${this.collectionEndpoint}`);
    const response = await fetch(this.recordsEndpoint, {
      method: "GET",
      headers: this.headers,
    });
    require200(response, "Can't retrieve records");
    const lastModified = response.headers.get("Last-Modified") ?? undefined;
    const { data } = await response.json() as any;
    return { data, lastModified };
  }

  #dryRunnable<Ps extends any[], R>(log: string | ((...params: Ps) => string), f: (...params: Ps) => Promise<R>): (...params: Ps) => Promise<R | true> {
    return async (...params) => {
      if (this.dryRun) {
        console.log(`[DRY_RUN] ${typeof log === "string" ? log : log(...params)}`);
        return true;
      } else {
        console.log(typeof log === "string" ? log : log(...params));
      }
      return await f(...params);
    };
  }

  /**
   * Update or insert a record on RemoteSettings
   *
   * @param {Object} The recordId, description, and hashes for the record.
   * @returns {boolean} Whether the API call was successful or not
   */
  readonly upsertRecord = this.#dryRunnable(
    ({ recordId, description }) => `Create ${recordId} (${description})`,
    async ({ recordId, description, hashes }: { recordId: string, description: string, hashes: string[] }) => {
      const response = await fetch(`${this.recordsEndpoint}/${recordId}`, {
        method: "PUT",
        body: JSON.stringify({ data: { description, hashes } }),
        headers: this.headers,
      });
      return await checkStatus(response, [200, 201], "Couldn't create record");
    });

  /**
   * Remove a record on RemoteSettings
   *
   * @param {RSRecord} record: The existing record on RemoteSettings
   * @returns {boolean} Whether the API call was successful or not
   */
  readonly deleteRecord = this.#dryRunnable(
    (record) => `Delete ${record.id} (${record.description})`,
    async (record: RSRecord) => {
      const response = await fetch(`${this.recordsEndpoint}/${record.id}`, {
        method: "DELETE",
        headers: this.headers,
      });
      return await checkStatus(response, 200, "Couldn't delete record");
    });

  /**
   * Automatically approve changes made on the collection.
   */
  readonly approveChanges = this.#dryRunnable("Approving changes",
    async () => {
      const response = await fetch(this.collectionEndpoint, {
        method: "PATCH",
        body: JSON.stringify({ data: { status: "to-sign" } }),
        headers: this.headers,
      });
      if (await checkStatus(response, 200, "Couldn't approve changes")) {
        console.log("Changes approved ✅");
      }
    });
}
