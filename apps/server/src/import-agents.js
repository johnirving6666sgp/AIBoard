import { importAgentOutputs } from "./agent-output-importer.js";

const result = await importAgentOutputs({ recentHours: 24 });
console.log(JSON.stringify(result, null, 2));
