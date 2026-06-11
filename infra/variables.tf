variable "subscription_id" {
  description = "Target Azure subscription ID."
  type        = string
  default     = "c39dc272-11c0-409e-93d2-da2156e3c20e"
}

variable "resource_group_name" {
  description = "Existing resource group that holds all Jarvis assets."
  type        = string
  default     = "Jarvis"
}

variable "location" {
  description = "Azure region for all resources (also used as the Speech region)."
  type        = string
  default     = "eastus2"
}

variable "name_prefix" {
  description = "Short prefix for resource names."
  type        = string
  default     = "jarvis"
}

variable "speech_sku" {
  description = "SKU for the Azure AI Speech (Cognitive Services) account."
  type        = string
  default     = "S0"
}

variable "container_image" {
  description = "Placeholder image for the Container App until the real API image ships."
  type        = string
  default     = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
}

variable "container_min_replicas" {
  description = "Minimum Container App replicas. 1 = always-on (no cold start) per the v1 plan."
  type        = number
  default     = 1
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default = {
    project = "jarvis"
    env     = "prod"
    managed = "terraform"
  }
}
