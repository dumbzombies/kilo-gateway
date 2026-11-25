// One-shot client for the device flow, so a terminal or agent can log in the
// same way warm-run-cli does:
//
//   bun src/authflow.ts http://127.0.0.1:28457
//   bun src/authflow.ts http://127.0.0.1:28457 --out ./credentials.json
//
// Prints the verification URI and code, polls until approval, then emits the
// credentials.json shape (schemaVersion, apiBaseUrl, accessToken, authStyle,
// expiresAt, user) to stdout or to --out.

import { writeFileSync } from "node:fs";
import { CLIENT_ID, DEVICE_GRANT } from "./accounts.ts";

const base = (process.argv[2] || process.env.KILO_GATEWAY_URL || "http://127.0.0.1:28457").replace(/\/$/, "");
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex > 0 ? process.argv[outIndex + 1] : "";

interface Grant {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface PollBody {
  access_token?: string;
  credentials?: unknown;
  error?: string;
  error_description?: string;
}

const startRes = await fetch(`${base}/api/auth/device/code`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_id: CLIENT_ID }),
});
if (!startRes.ok) {
  console.error(`device/code failed: ${startRes.status} ${await startRes.text()}`);
  process.exit(1);
}
const grant = (await startRes.json()) as Grant;

console.log(`Open ${grant.verification_uri_complete}`);
console.log(`Code: ${grant.user_code}  (expires in ${grant.expires_in}s)`);

const deadline = Date.now() + grant.expires_in * 1000;
let interval = grant.interval;
while (Date.now() < deadline) {
  await Bun.sleep(interval * 1000);
  const poll = await fetch(`${base}/api/auth/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: DEVICE_GRANT, device_code: grant.device_code, client_id: CLIENT_ID }),
  });
  const body = (await poll.json()) as PollBody;
  if (poll.ok) {
    const text = `${JSON.stringify(body.credentials, null, 2)}\n`;
    if (outPath) {
      writeFileSync(outPath, text, { mode: 0o600 });
      console.error(`credentials written to ${outPath}`);
    } else {
      process.stdout.write(text);
    }
    process.exit(0);
  }
  if (body.error === "slow_down") {
    interval = Math.min(interval + 5, 60);
    continue;
  }
  if (body.error === "authorization_pending") continue;
  console.error(`authorization failed: ${body.error} — ${body.error_description}`);
  process.exit(1);
}
console.error("device code expired before approval");
process.exit(1);
