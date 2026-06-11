import { ManagedIdentityCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

/**
 * Resolved runtime configuration for the orchestrator. Speech credentials are
 * loaded once at startup and cached for the process lifetime.
 */
export interface AppConfig {
  port: number;
  speechKey: string;
  speechRegion: string;
  defaultVoiceId: string;
}

const DEFAULT_VOICE_ID = "en-GB-RyanNeural";
const SPEECH_SECRET_NAME = "speech-key";
const CLAUDE_OAUTH_SECRET_NAME = "claude-oauth-token";

/**
 * Load the Claude Max subscription OAuth token and export it as
 * `CLAUDE_CODE_OAUTH_TOKEN` so the Claude Agent SDK authenticates against the
 * Max subscription (not a Console API key).
 *
 *  - In Azure: pulled from Key Vault (`claude-oauth-token`) via managed identity.
 *  - Locally: falls back to an existing `CLAUDE_CODE_OAUTH_TOKEN` env var.
 *
 * Non-fatal: if absent, we log a clear warning and let the service come up so
 * /healthz and /voices keep working — only the brain is unavailable until the
 * secret is provided. Never logs the token value.
 */
async function loadClaudeOAuthToken(): Promise<void> {
  // Local/dev path: token already in the environment.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.log(
      "[secrets] Using CLAUDE_CODE_OAUTH_TOKEN from environment (local/dev path).",
    );
    return;
  }

  const vaultUri = process.env.KEY_VAULT_URI;
  if (vaultUri) {
    try {
      const clientId = process.env.AZURE_CLIENT_ID;
      const credential = new ManagedIdentityCredential(
        clientId ? { clientId } : undefined,
      );
      const client = new SecretClient(vaultUri, credential);
      const secret = await client.getSecret(CLAUDE_OAUTH_SECRET_NAME);
      if (secret.value) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = secret.value;
        console.log("[secrets] Loaded Claude Max OAuth token from Key Vault.");
        return;
      }
      console.warn(
        "[secrets] claude-oauth-token from Key Vault had no value; brain will be unavailable.",
      );
    } catch (err) {
      console.warn(
        "[secrets] Could not load claude-oauth-token from Key Vault; brain will be unavailable until the secret is set. Reason:",
        (err as Error).message,
      );
      return;
    }
  }

  console.warn(
    "[secrets] No Claude Max OAuth token available (no CLAUDE_CODE_OAUTH_TOKEN env and none in Key Vault). " +
      "The service will start and serve /healthz and /voices, but the Claude brain will not work until the " +
      "'claude-oauth-token' Key Vault secret is set.",
  );
}

/**
 * Load the Azure Speech key.
 *  - In Azure: pulled from Key Vault using the Container App's user-assigned
 *    managed identity (clientId from AZURE_CLIENT_ID) with get/list on secrets.
 *  - Locally: falls back to process.env.SPEECH_KEY (managed identity is not
 *    available off-platform).
 */
async function loadSpeechKey(): Promise<string> {
  const envKey = process.env.SPEECH_KEY;
  const vaultUri = process.env.KEY_VAULT_URI;

  if (vaultUri) {
    try {
      const clientId = process.env.AZURE_CLIENT_ID;
      const credential = new ManagedIdentityCredential(
        clientId ? { clientId } : undefined,
      );
      const client = new SecretClient(vaultUri, credential);
      const secret = await client.getSecret(SPEECH_SECRET_NAME);
      if (secret.value) {
        console.log("[secrets] Loaded speech-key from Key Vault via managed identity.");
        return secret.value;
      }
      console.warn("[secrets] speech-key from Key Vault had no value; falling back to env.");
    } catch (err) {
      console.warn(
        "[secrets] Key Vault fetch failed; falling back to SPEECH_KEY env. Reason:",
        (err as Error).message,
      );
    }
  }

  if (envKey) {
    console.log("[secrets] Using SPEECH_KEY from environment (local/dev path).");
    return envKey;
  }

  throw new Error(
    "No Speech key available: neither Key Vault (KEY_VAULT_URI) nor SPEECH_KEY env yielded a value.",
  );
}

export async function loadConfig(): Promise<AppConfig> {
  const speechRegion = process.env.AZURE_SPEECH_REGION || "eastus2";
  const speechKey = await loadSpeechKey();
  // Export CLAUDE_CODE_OAUTH_TOKEN before any brain call. Non-fatal if absent.
  await loadClaudeOAuthToken();
  return {
    // Container App ingress target_port = 80, so default to 80.
    port: Number(process.env.PORT) || 80,
    speechKey,
    speechRegion,
    defaultVoiceId: process.env.JARVIS_DEFAULT_VOICE || DEFAULT_VOICE_ID,
  };
}
