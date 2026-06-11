output "container_app_fqdn" {
  description = "Public hostname of the Jarvis API Container App."
  value       = azurerm_container_app.api.latest_revision_fqdn
}

output "static_web_app_hostname" {
  description = "Default hostname of the Static Web App (React SPA)."
  value       = azurerm_static_web_app.web.default_host_name
}

output "static_web_app_api_key" {
  description = "Deployment token for the Static Web App (used by the SPA CI job)."
  value       = azurerm_static_web_app.web.api_key
  sensitive   = true
}

output "acr_login_server" {
  description = "Login server for the Container Registry."
  value       = azurerm_container_registry.acr.login_server
}

output "key_vault_uri" {
  description = "Key Vault URI."
  value       = azurerm_key_vault.kv.vault_uri
}

output "speech_endpoint" {
  description = "Azure AI Speech endpoint."
  value       = azurerm_cognitive_account.speech.endpoint
}

output "app_identity_client_id" {
  description = "Client ID of the Container App managed identity."
  value       = azurerm_user_assigned_identity.app.client_id
}
