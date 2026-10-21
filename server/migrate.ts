import { CURRENT_SCHEMA_VERSION, openDatabase } from "./db";

const database = await openDatabase();
try {
  console.log(`SQLite schema is current (version ${CURRENT_SCHEMA_VERSION}).`);
} finally {
  database.close();
}
