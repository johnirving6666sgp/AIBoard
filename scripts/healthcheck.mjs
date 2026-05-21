import http from "node:http";
import https from "node:https";

const endpoint = process.env.AIBOARD_HEALTH_URL || "http://127.0.0.1:4173/api/health";

try {
  const payload = await requestJson(endpoint);
  if (!payload.ok) {
    console.error(`AIBoard healthcheck failed: ${JSON.stringify(payload)}`);
    process.exit(1);
  }

  console.log(`AIBoard OK · Vault ${payload.vault?.status || "unknown"} · uptime ${payload.service?.uptimeSec || 0}s`);
} catch (error) {
  console.error(`AIBoard healthcheck failed: ${error.message}`);
  process.exit(1);
}

function requestJson(url) {
  const client = url.startsWith("https:") ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.get(url, { timeout: 5000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON: ${error.message}`));
        }
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", reject);
  });
}
