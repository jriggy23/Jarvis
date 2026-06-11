###############################################################################
# Jarvis — full v1 stack. All assets live in the existing "Jarvis" RG.
#
# RBAC note: the deploying service principal is Contributor-only and cannot
# create role assignments. We therefore use Key Vault access policies (not RBAC)
# and ACR admin credentials (not an AcrPull role) so the whole stack deploys
# without any roleAssignments write. Tighten to managed-identity RBAC once the
# SPN is elevated to User Access Administrator.
###############################################################################

data "azurerm_resource_group" "jarvis" {
  name = var.resource_group_name
}

data "azurerm_client_config" "current" {}

# Suffix for globally-unique resource names (ACR, Key Vault, Speech subdomain).
resource "random_string" "suffix" {
  length  = 6
  lower   = true
  upper   = false
  numeric = true
  special = false
}

###############################################################################
# Observability — Log Analytics + Application Insights
###############################################################################

resource "azurerm_log_analytics_workspace" "law" {
  name                = "${var.name_prefix}-law"
  resource_group_name = data.azurerm_resource_group.jarvis.name
  location            = data.azurerm_resource_group.jarvis.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.tags
}

resource "azurerm_application_insights" "appi" {
  name                = "${var.name_prefix}-appi"
  resource_group_name = data.azurerm_resource_group.jarvis.name
  location            = data.azurerm_resource_group.jarvis.location
  workspace_id        = azurerm_log_analytics_workspace.law.id
  application_type    = "web"
  tags                = var.tags
}

###############################################################################
# Container Registry (Basic) — admin user enabled so the Container App can pull
# without an AcrPull role assignment (see RBAC note above).
###############################################################################

resource "azurerm_container_registry" "acr" {
  name                = "${var.name_prefix}acr${random_string.suffix.result}"
  resource_group_name = data.azurerm_resource_group.jarvis.name
  location            = data.azurerm_resource_group.jarvis.location
  sku                 = "Basic"
  admin_enabled       = true
  tags                = var.tags
}

###############################################################################
# Managed identity for the Container App (stable principal for Key Vault access)
###############################################################################

resource "azurerm_user_assigned_identity" "app" {
  name                = "${var.name_prefix}-app-id"
  resource_group_name = data.azurerm_resource_group.jarvis.name
  location            = data.azurerm_resource_group.jarvis.location
  tags                = var.tags
}

###############################################################################
# Azure AI Speech (Cognitive Services, kind = SpeechServices)
###############################################################################

resource "azurerm_cognitive_account" "speech" {
  name                  = "${var.name_prefix}-speech"
  resource_group_name   = data.azurerm_resource_group.jarvis.name
  location              = data.azurerm_resource_group.jarvis.location
  kind                  = "SpeechServices"
  sku_name              = var.speech_sku
  custom_subdomain_name = "${var.name_prefix}-speech-${random_string.suffix.result}"
  tags                  = var.tags
}

###############################################################################
# Key Vault (access-policy mode) — holds provider secrets. The deploying SPN
# gets manage rights; the Container App identity gets read-only on secrets.
###############################################################################

resource "azurerm_key_vault" "kv" {
  name                       = "${var.name_prefix}-kv-${random_string.suffix.result}"
  resource_group_name        = data.azurerm_resource_group.jarvis.name
  location                   = data.azurerm_resource_group.jarvis.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = false
  purge_protection_enabled   = false
  soft_delete_retention_days = 7
  tags                       = var.tags

  # Deploying service principal: full secret management (to write secrets below).
  access_policy {
    tenant_id = data.azurerm_client_config.current.tenant_id
    object_id = data.azurerm_client_config.current.object_id

    secret_permissions = [
      "Get", "List", "Set", "Delete", "Purge", "Recover",
    ]
  }

  # Container App managed identity: read-only on secrets at runtime.
  access_policy {
    tenant_id = data.azurerm_client_config.current.tenant_id
    object_id = azurerm_user_assigned_identity.app.principal_id

    secret_permissions = [
      "Get", "List",
    ]
  }
}

resource "azurerm_key_vault_secret" "speech_key" {
  name         = "speech-key"
  value        = azurerm_cognitive_account.speech.primary_access_key
  key_vault_id = azurerm_key_vault.kv.id
  tags         = var.tags
}

###############################################################################
# Container Apps — environment + the always-on API app (placeholder image)
###############################################################################

resource "azurerm_container_app_environment" "env" {
  name                       = "${var.name_prefix}-env"
  resource_group_name        = data.azurerm_resource_group.jarvis.name
  location                   = data.azurerm_resource_group.jarvis.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.law.id
  tags                       = var.tags
}

resource "azurerm_container_app" "api" {
  name                         = "${var.name_prefix}-api"
  resource_group_name          = data.azurerm_resource_group.jarvis.name
  container_app_environment_id = azurerm_container_app_environment.env.id
  revision_mode                = "Single"
  tags                         = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server               = azurerm_container_registry.acr.login_server
    username             = azurerm_container_registry.acr.admin_username
    password_secret_name = "acr-password"
  }

  secret {
    name  = "acr-password"
    value = azurerm_container_registry.acr.admin_password
  }

  ingress {
    external_enabled = true
    target_port      = 80
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.container_min_replicas
    max_replicas = 3

    container {
      name   = "${var.name_prefix}-api"
      image  = var.container_image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        value = azurerm_application_insights.appi.connection_string
      }
      env {
        name  = "KEY_VAULT_URI"
        value = azurerm_key_vault.kv.vault_uri
      }
      env {
        name  = "AZURE_SPEECH_REGION"
        value = var.location
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.app.client_id
      }
    }
  }
}

###############################################################################
# Static Web App (Free) — the React SPA host
###############################################################################

resource "azurerm_static_web_app" "web" {
  name                = "${var.name_prefix}-web"
  resource_group_name = data.azurerm_resource_group.jarvis.name
  location            = data.azurerm_resource_group.jarvis.location
  sku_tier            = "Free"
  sku_size            = "Free"
  tags                = var.tags
}
