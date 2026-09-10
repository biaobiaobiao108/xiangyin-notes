import { openDatabase } from "../server/db";

const database = await openDatabase();
database.close();
console.log("SQLite migrations applied.");
