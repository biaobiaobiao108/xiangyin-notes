import { applyMigrations, openDatabase } from "./db";
import { backfillNoteShortSearchTerms } from "./note-search";

const database = await openDatabase();
await applyMigrations(database);
backfillNoteShortSearchTerms(database);
database.close();
console.log("SQLite migrations applied.");
