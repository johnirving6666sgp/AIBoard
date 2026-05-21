import fs from "node:fs/promises";
import path from "node:path";
import { configPath, rootDir } from "./paths.js";

const defaultConfig = {
  vault: {
    enabled: false,
    rootPath: "",
    researchQueuePath: "研究队列.md",
    trackingPath: "持仓与跟踪.md",
    watchFolders: ["companies", "sectors", "governor"],
    pollMs: 15000
  }
};

export async function loadConfig() {
  const config = await readJsonIfExists(configPath);
  const localConfig = await readJsonIfExists(path.join(rootDir, "config", "aiboard.config.local.json"));
  return mergeConfig(mergeConfig(defaultConfig, config), localConfig);
}

function mergeConfig(base, override) {
  if (!override) return base;
  return {
    ...base,
    ...override,
    vault: {
      ...base.vault,
      ...(override.vault || {})
    }
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
