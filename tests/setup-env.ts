// Each test file gets its own empty data folder and runs in mock mode.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENCREWBOT_DATA_DIR = mkdtempSync(join(tmpdir(), "opencrewbot-test-"));
process.env.OPENCREWBOT_MOCK = "1";
for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "GMAIL_USER", "GMAIL_APP_PASSWORD", "SMTP_USER", "SMTP_PASSWORD", "SLACK_WEBHOOK_URL", "NOTION_TOKEN"]) delete process.env[key];
