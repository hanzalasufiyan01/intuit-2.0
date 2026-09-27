import { customType, timestamp } from 'drizzle-orm/pg-core';

/** PostgreSQL bytea mapped to a Node.js Buffer. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** timestamptz mapped to a JavaScript Date. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
