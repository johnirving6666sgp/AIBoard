import { importInbox } from "./inbox-importer.js";

const result = await importInbox();
console.log(JSON.stringify(result, null, 2));
