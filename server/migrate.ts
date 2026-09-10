import { applyMigrations, openDatabase } from "./db";

const database = await openDatabase();
await applyMigrations(database);
database.close();
console.log("SQLite migrations applied.");
