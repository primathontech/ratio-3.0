variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "environment" {
  type    = string
  default = "dev"
  # Names every resource; a typo would create a parallel stack. Also remember the backend key is NOT
  # parameterized (see main.tf) — changing this alone does not repoint state.
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}
