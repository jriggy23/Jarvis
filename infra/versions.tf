terraform {
  required_version = ">= 1.6.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state lives in the Jarvis resource group (bootstrapped out-of-band).
  # The storage account key is supplied at runtime via ARM_ACCESS_KEY so the
  # Contributor-scoped service principal does not need a data-plane role grant.
  backend "azurerm" {
    resource_group_name  = "Jarvis"
    storage_account_name = "jarvistfstatea44771"
    container_name       = "tfstate"
    key                  = "jarvis-infra.tfstate"
  }
}
