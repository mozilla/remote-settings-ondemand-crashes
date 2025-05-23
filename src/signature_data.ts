/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

import { BigQuery } from "@google-cloud/bigquery";
import { readFile } from "node:fs/promises";

const BIGQUERY_PROJECT_ID = "moz-fx-data-shared-prod";

const NEW_DATA_QUERY = `
select COUNT(*) as count
from moz-fx-data-shared-prod.crash_ping_ingest_external.ingest_output
where submission_timestamp >= @date
`;

const TOP_CRASH_QUERY_PARAMS = {
  // Period over which we count signature reports.
  report_interval_days: 30,
  // Period over which we count signature ping clients.
  ping_interval_days: 7,
  // Take the top N signatures by client count.
  top_crasher_count: 10,
  // The minimum number of reports for a signature to disqualify it.
  report_minimum: 10,
  // The maximum number of hashes to select for a particular signature and platform.
  max_hashes_per_config: 100,
};

export type SignatureHashes = {
  signature: string,
  process_type: string,
  channel: string,
  os: string,
  minidump_hashes: string[]
};

export default class SignatureData {
  readonly #client: BigQuery;

  constructor() {
    this.#client = new BigQuery({ projectId: BIGQUERY_PROJECT_ID });
  }

  async newDataSince(date: Date): Promise<boolean> {
    const result = await this.#query<{ count: number }>(NEW_DATA_QUERY, { date });
    return result[0].count > 0;
  }

  async selectHashes(): Promise<SignatureHashes[]> {
    const query = await readFile(`${import.meta.dirname}/top_crash_signatures.sql`, "utf8");
    return await this.#query(query, TOP_CRASH_QUERY_PARAMS);
  }

  async #query<T>(query: string, params?: Record<string, any>): Promise<T[]> {
    const stream = this.#client.createQueryStream({ query, params });
    return await new Promise((resolve, reject) => {
      const rows: any[] = [];
      stream.on('error', reject);
      stream.on('data', row => rows.push(row));
      stream.on('end', () => resolve(rows));
    });
  }
}
