import { runDispatchedCommands } from "./agent-adapters.js";

const result = await runDispatchedCommands({ limit: 10 });
console.log(JSON.stringify(result, null, 2));
