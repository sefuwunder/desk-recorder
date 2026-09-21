// desk-recorder entry point. Bun + zero deps + SQLite, port 3010.
import { buildApp } from "./app.ts";

const port = Number(process.env.PORT || 3010);
const dataDir = process.env.DATA_DIR || new URL("../data/", import.meta.url).pathname;

buildApp({ port, dataDir });
console.log(`desk-recorder running at http://localhost:${port}`);
