import { applyMigrations, openDatabase } from "./db";
import { backfillNormalizedNoteTitleKeys } from "./note-links";
import { backfillNoteShortSearchTerms } from "./note-search";

const database = await openDatabase();
await applyMigrations(database);
backfillNormalizedNoteTitleKeys(database);
backfillNoteShortSearchTerms(database);
database.close();
console.log("SQLite migrations applied.");
