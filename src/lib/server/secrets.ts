// Credentials for integrations. A value can come from the environment (.env) or
// be typed into the Integration manager, in which case it is encrypted with
// AES-256-GCM before it is stored. The encryption key lives in the data folder
// (or in OPENCREWBOT_SECRET_KEY), never in the database and never in source code.
// Secret values are never sent to the browser: the UI only learns whether one is set.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config";
import { getSetting, setSetting } from "./db";

function key(): Buffer {
  const fromEnv = process.env.OPENCREWBOT_SECRET_KEY;
  if (fromEnv) return createHash("sha256").update(fromEnv).digest();
  const path = join(DATA_DIR, ".secret-key");
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600 });
  return Buffer.from(readFileSync(path, "utf8").trim(), "hex");
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

function decrypt(stored: string): string | null {
  try {
    const [iv, tag, data] = stored.split(".").map((p) => Buffer.from(p, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const settingKey = (name: string) => `secret.${name}`;

/** Read a credential: the environment wins, then the encrypted store. `aliases` are
 * other environment variable names accepted for the same value. */
export async function getSecret(name: string, aliases: string[] = []): Promise<string | undefined> {
  for (const n of [name, ...aliases]) if (process.env[n]) return process.env[n];
  const stored = await getSetting<string>(settingKey(name));
  return stored ? (decrypt(stored) ?? undefined) : undefined;
}

export async function setSecret(name: string, value: string): Promise<void> {
  await setSetting(settingKey(name), value.trim() ? encrypt(value.trim()) : "");
}

export async function hasSecret(name: string, aliases: string[] = []): Promise<boolean> {
  return Boolean(await getSecret(name, aliases));
}

/** Where a credential came from, for the Integration manager. */
export async function secretSource(name: string, aliases: string[] = []): Promise<"env" | "app" | null> {
  for (const n of [name, ...aliases]) if (process.env[n]) return "env";
  return (await getSetting<string>(settingKey(name))) ? "app" : null;
}
