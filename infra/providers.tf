provider "azurerm" {
  features {}

  subscription_id = var.subscription_id

  # The deploying service principal is Contributor-scoped; it can register
  # resource providers but we keep registration explicit to avoid surprises.
  resource_provider_registrations = "core"
}

provider "random" {}
