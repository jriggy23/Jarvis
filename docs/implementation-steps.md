# Jarvis — Implementation Steps (Front → Back)

> A detailed, chronological record of how Jarvis v1 was built: from the Azure
> landing zone, through CI/CD and infrastructure-as-code, the React front end,
> the Node orchestrator, Azure AI Speech, and the Claude (Max-subscription)
> brain — including the bugs hit along the way and how they were fixed.
>
> **Status at time of writing:** v1 backend is live end-to-end (text → Claude →
> reply, with multi-turn memory). Voice (STT/TTS) is wired server-side; the only
> remaining v1 task is connecting the browser SPA to the realtime WebSocket.
>
> **Security note:** This document contains **no secret values**. Secrets (the
> service-principal client secret, the Claude OAuth token, Speech keys, storage
> account keys, deployment tokens) live only in **Azure Key Vault** or **GitHub
> Actions secrets** and are referenced here by name/location, never by value.

---

## 0. Conventions & Identifiers

Non-secret identifiers used throughout (these are resource names and Entra/Azure
IDs — not credentials):

| Thing | Value |
|---|---|
| GitHub repo | `jriggy23/Jarvis` (default branch `main`) |
| Azure subscription | `Visual Studio Enterprise with MSDN` (`c39dc272-11c0-409e-93d2-da2156e3c20e`) |
| Entra tenant | `d0432e90-1479-4536-a727-c19d9cbd99d3` (jkcons.com) |
| Deploy service principal (app/client id) | `d8732716-16b2-4c0a-a098-619a8e5e10b4` (role: **Contributor** at subscription scope) |
| Resource group | `Jarvis` (region **eastus2**) |

**Secrets — never in git, never in this doc:**
- SPN client secret → used once for `az login`; should be rotated and kept out of source.
- Speech key → Key Vault secret `speech-key`.
- Claude Max OAuth token → Key Vault secret `claude-oauth-token`.
- Terraform state storage key → fetched at runtime in CI (`ARM_ACCESS_KEY`), never stored.
- Static Web App deployment token → GitHub Actions secret `AZURE_STATIC_WEB_APPS_API_TOKEN`.

---

## 1. Azure Landing Zone

### 1.1 Authenticate
The Azure CLI was authenticated and the target subscription selected:

```bash
az login                      # interactive (or: az login --service-principal ... for the SPN)
az account set --subscription "c39dc272-11c0-409e-93d2-da2156e3c20e"
az account show -o table
```

> The deploy pipelines authenticate non-interactively via **GitHub OIDC** (see §2.3) — no long-lived cloud credential is stored in GitHub.

### 1.2 Clean the subscription
Stale resource groups from prior experiments were removed, keeping only `Jarvis`:

```bash
az group list -o table
# delete everything except Jarvis (irreversible — each RG and its contents)
for rg in <old-rgs...>; do az group delete --name "$rg" --yes --no-wait; done
```

### 1.3 Confirm the target RG
`Jarvis` already existed (empty) in `eastus2` and became the home for **all** Jarvis
assets — a deliberate constraint: everything lives in one resource group.

---

## 2. CI/CD + Infrastructure as Code (Terraform)

**Decisions locked here:** IaC = **Terraform**; CI = **GitHub Actions**; cloud auth
= **GitHub OIDC** (federated, secretless); scope = **full v1 stack**, all in the
`Jarvis` RG.

### 2.1 Bootstrap remote state
Terraform state must live remotely so each CI run shares it. A storage account +
blob container were created out-of-band, inside the `Jarvis` RG:

```bash
# storage account name is globally unique; container = tfstate
az storage account create -n jarvistfstatea44771 -g Jarvis -l eastus2 \
  --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 \
  --allow-blob-public-access false
az storage container create --name tfstate --account-name jarvistfstatea44771 --auth-mode login
```

State backend: account `jarvistfstatea44771`, container `tfstate`, key
`jarvis-infra.tfstate`. In CI the storage key is fetched at runtime (`az storage
account keys list` → `ARM_ACCESS_KEY`) so the Contributor SPN needs no data-plane
role grant.

### 2.2 Terraform configuration (`infra/`)
Files authored:

| File | Purpose |
|---|---|
| `infra/versions.tf` | Terraform & provider versions (`azurerm ~> 4`, `random`), `azurerm` backend block |
| `infra/providers.tf` | `azurerm` provider (`features {}`, `subscription_id`, `resource_provider_registrations = "core"`) |
| `infra/variables.tf` | subscription, RG name, location, name prefix, speech SKU, container image, replicas, tags |
| `infra/main.tf` | all resources (below) |
| `infra/outputs.tf` | FQDNs, login server, KV URI, Speech endpoint, app identity client id, SWA token (sensitive) |
| `infra/.gitignore` | ignores `.terraform/`, state, `*.tfvars`, plan files |

**Resources provisioned (all in `Jarvis`, eastus2):**

1. `random_string.suffix` — 6-char suffix for globally-unique names.
2. `azurerm_log_analytics_workspace.law` — `jarvis-law`.
3. `azurerm_application_insights.appi` — `jarvis-appi` (workspace-based).
4. `azurerm_container_registry.acr` — `jarvisacr<suffix>` (Basic, **admin enabled**).
5. `azurerm_user_assigned_identity.app` — `jarvis-app-id` (the Container App's identity).
6. `azurerm_cognitive_account.speech` — `jarvis-speech` (kind `SpeechServices`, SKU `S0`, custom subdomain).
7. `azurerm_key_vault.kv` — `jarvis-kv-<suffix>` (**access-policy mode**, not RBAC).
8. `azurerm_key_vault_secret.speech_key` — `speech-key` (Speech primary key).
9. `azurerm_container_app_environment.env` — `jarvis-env` (linked to Log Analytics).
10. `azurerm_container_app.api` — `jarvis-api` (always-on, external ingress :80, placeholder image initially; later real image).
11. `azurerm_static_web_app.web` — `jarvis-web` (Free tier).

**RBAC sidesteps (because the SPN is Contributor-only and cannot create role
assignments):**
- **Key Vault** uses **access policies** (a vault property Contributor can set), not
  RBAC roles. The deploying SPN gets secret get/list/set; the Container App's
  managed identity gets get/list.
- **ACR** uses the **admin user** + registry credentials for the Container App to
  pull, instead of an `AcrPull` role assignment.
- **Image builds** in CI use `az acr build` (a control-plane op Contributor can run),
  avoiding the need for `docker push` / `AcrPush`.

**Drift guard:** `azurerm_container_app.api` has
`lifecycle { ignore_changes = [template[0].container[0].image] }` so the app's
image — updated out-of-band by the API pipeline — is not reverted by
`terraform apply`.

### 2.3 GitHub OIDC (secretless Azure auth)
Two **federated credentials** were added to the SPN's app registration (this is an
Entra/Microsoft Graph operation — it requires an admin identity, **not** the
Contributor SPN itself):

```bash
# run under an admin identity (e.g. portal Cloud Shell)
az ad app federated-credential create --id <APP_ID> --parameters '{
  "name":"github-jarvis-main","issuer":"https://token.actions.githubusercontent.com",
  "subject":"repo:jriggy23/Jarvis:ref:refs/heads/main","audiences":["api://AzureADTokenExchange"]}'
az ad app federated-credential create --id <APP_ID> --parameters '{
  "name":"github-jarvis-pr","issuer":"https://token.actions.githubusercontent.com",
  "subject":"repo:jriggy23/Jarvis:pull_request","audiences":["api://AzureADTokenExchange"]}'
```

GitHub repo **secrets** set (non-sensitive IDs, no secret values):
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.

### 2.4 Infra pipeline (`.github/workflows/infra.yml`)
- **PR** touching `infra/**` → `terraform fmt -check` → `init` → `validate` → `plan`.
- **Push to main** touching `infra/**` → `apply`.
- Auth: `azure/login@v2` via OIDC (`permissions: id-token: write`). State key fetched
  at runtime and masked.

### 2.5 Resource-provider registration
First `apply` failed because the subscription hadn't registered some namespaces.
Registered once (idempotent):

```bash
for ns in Microsoft.App Microsoft.CognitiveServices Microsoft.ContainerRegistry \
          Microsoft.KeyVault Microsoft.OperationalInsights Microsoft.Insights \
          Microsoft.Web Microsoft.ManagedIdentity; do
  az provider register --namespace "$ns"
done
```

After registration, the `apply` succeeded: **11 resources created**, all in `Jarvis`.

**Live endpoints produced:**
- API (Container App): `https://jarvis-api.salmonbush-0f329da2.eastus2.azurecontainerapps.io`
- Web (Static Web App): `https://ambitious-sea-0cf341e0f.7.azurestaticapps.net`

---

## 3. Front End — React SPA (`web/`)

**Stack:** Vite + React + TypeScript. Dark, calm, "presence"-centric UI.

### 3.1 Scaffold
Files created under `web/`:

| File | Purpose |
|---|---|
| `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html` | Vite/React/TS project |
| `src/main.tsx` | App bootstrap, wraps in `ThemeProvider` |
| `src/theme.tsx` | Orb-color store: presets + custom color, persisted to `localStorage`, exposes a CSS var; `TODO` to also persist via `PATCH /sessions/{id}` later |
| `src/components/JarvisOrb.tsx` | The reactive "presence" orb (canvas, 60fps) |
| `src/components/OrbColorPicker.tsx` | Preset swatches + custom color picker |
| `src/App.tsx` | Layout, mic capture (Web Audio `AnalyserNode`), state switcher, text input |
| `src/index.css` | Dark theme; accents driven by the selected orb color |

### 3.2 The orb — state-driven & reactive
The orb is a state machine driven (eventually) by the orchestrator's WS events:
`idle` → `listening` (mic amplitude) → `thinking` → `speaking` (TTS amplitude).
It takes three props — `color`, `state`, `amplitude` — so wiring it to the backend
later is just mapping WS events to those.

**Design iterations (each refined live with the user):**
1. Reactive **orb** chosen as the signature visual (over HUD rings / waveform).
2. External ring made **3-dimensional with individual dots**.
3. Reframed to a **satellite constellation** (multiple orbital shells), dots much
   smaller and far more numerous, shells evenly spaced, equal radius, pulled in
   tight to the core; satellites expand outward on "speaking".
4. Final form: a **filament-swarm sphere** matching an amber HUD reference — a hot
   white-gold core, a swarm of fine particles each on its **own random orbital
   path** (Rodrigues rotation about a random axis), a planetary limb, and an
   **Ember** (amber) default palette on near-black.

### 3.3 Color selector
`OrbColorPicker` provides preset swatches (Ember, Stark Gold, Arc Blue, Emerald,
Violet, Crimson, Ice White) plus a native custom color input. Selection persists
and recolors the orb, glow, buttons, and accents instantly.

### 3.4 Web deploy pipeline (`.github/workflows/web.yml`)
- Triggers on push/PR to `main` touching `web/**`.
- Builds the Vite app (`npm ci` + `npm run build`), then deploys with
  `Azure/static-web-apps-deploy@v1`, publishing the **pre-built `web/dist`**
  (`app_location: web/dist`, `skip_app_build: true`).
- Uses GitHub secret `AZURE_STATIC_WEB_APPS_API_TOKEN` (the SWA deployment token,
  pulled from `az staticwebapp secrets list` and stored as a secret — value never in
  source).
- PR builds create SWA preview environments; a close job tears them down.

> A first attempt published the source tree instead of the build (the live page
> referenced `/src/main.tsx` and the bundle 404'd); fixed by pointing at the
> pre-built `dist`.

---

## 4. Backend — Node Orchestrator (`api/`)

**Stack:** Node 20 + TypeScript, Express (REST) + `ws` (WebSocket), sharing one HTTP
server. Listens on port **80** (matches Container App ingress `target_port`).

### 4.1 Structure
```
api/
  Dockerfile                 multi-stage: builder (npm ci, tsc) -> node:20-slim runtime
  package.json / lock        deps + scripts
  tsconfig.json
  src/
    index.ts                 bootstrap: telemetry, secrets, CORS, Express + WS, listen
    auth.ts                  no-op pass-through stub (TODO: validate Entra ID token)
    sessions.ts              in-memory session store (single-replica note)
    chunker.ts               incremental sentence/clause chunker for token -> TTS
    config/
      secrets.ts             load Key Vault secrets via managed identity
      telemetry.ts           optional Application Insights init
    providers/
      types.ts               VoiceProvider + BrainProvider interfaces
      azureSpeech.ts         Azure AI Speech (STT push stream + streaming TTS)
      claudeBrain.ts         Claude Agent SDK brain (Max OAuth)
      stubBrain.ts           legacy echo brain (now unused)
    routes/index.ts          REST endpoints
    ws/realtime.ts           /realtime WS turn state machine
```

### 4.2 API contract (§7 of the architecture plan)
**REST:** `GET /healthz`, `POST /sessions`, `GET /sessions/:id`, `PATCH /sessions/:id`,
`POST /sessions/:id/messages`, `GET /sessions/:id/messages`, `GET /voices`,
`GET /config` (+ `GET /me`).

**WebSocket `/realtime`:** client → `audio.chunk`, `audio.end`, `text.message`,
`control.barge_in`, `control.set_voice`; server → `stt.partial`, `stt.final`,
`brain.status`, `brain.token`, `tts.audio` (base64 + mime), `turn.complete`, `error`.

**Turn state machine:** idle → listening (feed STT) → thinking (brain) → speaking
(clause-chunked TTS) → complete, with barge-in cancellation.

CORS allows the live SWA origin and `http://localhost:5173` (dev). Auth is a no-op
stub for v1 (Entra validation is a later task).

### 4.3 Secrets at runtime
`config/secrets.ts` uses `@azure/identity` `ManagedIdentityCredential({ clientId:
process.env.AZURE_CLIENT_ID })` + `@azure/keyvault-secrets` to read from the vault
(`KEY_VAULT_URI`). It loads:
- `speech-key` → Azure Speech.
- `claude-oauth-token` → sets `process.env.CLAUDE_CODE_OAUTH_TOKEN` for the brain.

The Container App injects these env vars (set in Terraform): `KEY_VAULT_URI`,
`AZURE_SPEECH_REGION`, `AZURE_CLIENT_ID`, `APPLICATIONINSIGHTS_CONNECTION_STRING`.

### 4.4 Azure AI Speech (`providers/azureSpeech.ts`)
`microsoft-cognitiveservices-speech-sdk`:
- **STT:** push-stream (16 kHz/16-bit/mono PCM), continuous recognition →
  partial/final callbacks.
- **TTS:** streaming Neural synthesis, output `Audio24Khz48KBitRateMonoMp3` (browser
  -friendly), calm SSML, chunks streamed as they synthesize.
- **Voices:** curated `en-GB` neural set; default **`en-GB-RyanNeural`**.

### 4.5 API deploy pipeline (`.github/workflows/api.yml`)
- Triggers on push to `main` touching `api/**`.
- OIDC `azure/login@v2`, then:
  - `az acr build --registry jarvisacr<suffix> --image jarvis-api:<sha> --image jarvis-api:latest ./api`
  - `az containerapp update -n jarvis-api -g Jarvis --image jarvisacr<suffix>.azurecr.io/jarvis-api:<sha>`

The first deploy replaced the placeholder hello-world image with the real
orchestrator. Verified live: `/healthz` 200, `/voices` returns the en-GB voices
(proving Speech key load via managed identity), REST turn returns a (then-stub) reply.

---

## 5. The Brain — Claude via Agent SDK (Max subscription)

**Decision:** authenticate Claude through the user's **Claude Max subscription**
(draws on included credit) using an **OAuth token**, rather than a metered Console
API key.

### 5.1 Implementation (`providers/claudeBrain.ts`)
- Package: **`@anthropic-ai/claude-agent-sdk`** — `query({ prompt, options })` returns
  an async stream of agent messages.
- **Model:** `CLAUDE_MODEL` env var, default **`claude-opus-4-8`**.
- **Streaming:** `includePartialMessages: true`; token text is read from
  `stream_event` → `content_block_delta` → `text_delta`, yielded into the existing
  WS `brain.token` / clause-TTS pipeline.
- **System prompt:** Jarvis persona — calm, concise, British register, plain text
  (no markdown/emoji, since output is read aloud).
- **Tools:** OFF for v1 (conversational brain; agentic tools are a v2 item).
- **Multi-turn:** per-session **history replay** (each turn rebuilds a compact
  transcript from the session's own history) — chosen over the SDK `resume` because
  the provider is a process-shared singleton and a shared resume id would
  cross-contaminate concurrent sessions.

### 5.2 Auth setup (manual, one-time — done by the human, not CI)
The OAuth token can only be minted interactively with the Max login, so this is a
manual step. **The token value itself is never committed or shown here** — it lives
only in Key Vault.

```bash
# 1) Mint the Max OAuth token (opens a browser to the Claude Max login)
npx @anthropic-ai/claude-code setup-token        # prints sk-ant-oat01-...  (SECRET)

# 2) Grant the admin user vault write access, then store the token
az keyvault set-policy --name jarvis-kv-<suffix> \
  --upn "$(az account show --query user.name -o tsv)" \
  --secret-permissions get set list
az keyvault secret set --vault-name jarvis-kv-<suffix> \
  --name claude-oauth-token --value "<PASTE_TOKEN — NOT STORED IN GIT>"

# 3) Roll the revision so the backend re-reads the secret at startup
az containerapp revision restart -n jarvis-api -g Jarvis \
  --revision "$(az containerapp show -n jarvis-api -g Jarvis --query properties.latestRevisionName -o tsv)"
```

### 5.3 Dockerfile considerations
The Agent SDK spawns a bundled `claude` CLI subprocess. The runtime image adds
`ca-certificates` + `git` and sets a writable `HOME` / `CLAUDE_CONFIG_DIR`. The
platform-specific CLI binary (a Linux optional dependency) resolves correctly on
`node:20-slim` (glibc/linux-x64) via the lockfile.

### 5.4 The root-permissions bug (and fix)
**Symptom:** every brain turn returned `Claude Code process exited with code 1`,
even though startup logged the token loaded and the model ready. It worked locally
but not in the container, and the CLI wrote nothing to stderr.

**Diagnosis (staged, via the CI pipeline since ad-hoc prod deploys are blocked):**
1. Added an `stderr` callback to the SDK options → still silent.
2. Enabled the SDK `debug` flag → revealed the real message:
   `--dangerously-skip-permissions cannot be used with root/sudo privileges`.

**Root cause:** `permissionMode: "bypassPermissions"` makes the SDK pass the CLI's
`--dangerously-skip-permissions` flag, which the Claude Code CLI **refuses to run as
root** — and the Container App runs the process as root.

**Fix:** since tools are disabled, there are **no permissions to bypass**, so the flag
was removed entirely (default mode never prompts when there are no tools). Verified
locally, then live.

**Live verification (two-turn conversation against the deployed API):**
- Turn 1 → *"Good day. I'm Jarvis, your calm and concise assistant… I've noted the
  word HELIOTROPE."*
- Turn 2 ("what word did I ask you to remember?") → *"The word was HELIOTROPE."*
  (confirms real Claude + multi-turn memory).

---

## 6. Current Resource Inventory (RG `Jarvis`, eastus2)

| Resource | Name | Notes |
|---|---|---|
| Container App | `jarvis-api` | Orchestrator + Speech + Claude brain; external ingress |
| Container Apps Env | `jarvis-env` | linked to Log Analytics |
| Container Registry | `jarvisacr<suffix>` | Basic, admin enabled |
| Key Vault | `jarvis-kv-<suffix>` | access-policy mode; secrets `speech-key`, `claude-oauth-token` |
| Azure AI Speech | `jarvis-speech` | SpeechServices S0 |
| App Insights | `jarvis-appi` | workspace-based |
| Log Analytics | `jarvis-law` | |
| Managed Identity | `jarvis-app-id` | Container App identity; KV get/list |
| Static Web App | `jarvis-web` | Free tier; hosts the SPA |
| Storage (TF state) | `jarvistfstatea44771` | container `tfstate` |

**Pipelines:** `infra.yml` (Terraform), `web.yml` (SWA), `api.yml` (Container App).
All authenticate via GitHub OIDC.

---

## 7. Known Gaps / Next Steps

- **Step 4 (remaining v1):** wire the SPA orb to the orchestrator `/realtime`
  WebSocket so voice/text round-trips in the browser (mic → STT → thinking →
  Claude → TTS → speaking). Point the SPA at the API base URL via config.
- **Auth:** REST/WS auth is a no-op stub — add Entra ID (OIDC) validation.
- **Sessions:** in-memory store is single-replica only; `jarvis-api` may scale 1→3.
  Pin `max_replicas = 1` or move to a shared store before scaling out.
- **Cleanup:** delete the now-unused `stubBrain.ts`.
- **Latency:** first-token latency on a cold turn was ~30s (cache warm-up);
  subsequent turns are faster — worth monitoring.
- **Token hygiene:** the SPN client secret and the Claude OAuth token were handled
  manually during setup; rotate them and keep them only in Key Vault / Entra.
- **v2:** enable agentic tools in the brain ("Dispatch" session), barge-in polish,
  cost/credit telemetry, then the native iOS client.

---

*This document records implementation steps and decisions only. It intentionally
contains no secret values — all credentials live in Azure Key Vault or GitHub
Actions secrets.*
