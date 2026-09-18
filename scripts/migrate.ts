import { applyMigrations, openDatabase } from "../server/db";
import { backfillNoteShortSearchTerms } from "../server/note-search";

const database = await openDatabase();
await applyMigrations(database);
backfillNoteShortSearchTerms(database);
database.close();
console.log("SQLite migrations applied.");
