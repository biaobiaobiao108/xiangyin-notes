import { runVacuum } from "../server/vacuum";

const targetPath = process.argv[2]?.trim();
await runVacuum(targetPath);
