import { applyMigrations, openDatabase } from "../server/db";
import { backfillNormalizedNoteTitleKeys } from "../server/note-links";
import { backfillNoteShortSearchTerms } from "../server/note-search";

const database = await openDatabase();
await applyMigrations(database);
backfillNormalizedNoteTitleKeys(database);
backfillNoteShortSearchTerms(database);
database.close();
console.log("SQLite migrations applied.");
