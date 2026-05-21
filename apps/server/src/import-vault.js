import { loadConfig } from "./config.js";
import { importVault } from "./vault-importer.js";

const result = await importVault(await loadConfig());
console.log(JSON.stringify(result, null, 2));
