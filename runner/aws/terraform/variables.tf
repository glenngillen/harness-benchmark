variable "region" {
  description = "AWS region for the runner and its records bucket."
  type        = string
  default     = "ap-southeast-2"
}

variable "name_prefix" {
  description = "Prefix for resource names."
  type        = string
  default     = "harness-benchmark"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name_prefix))
    error_message = "Use 3-31 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "instance_type" {
  description = "Small x86_64 instance type. The campaign runs at concurrency one, but each attempt runs a coding CLI, the app, its worker and headless Chromium, so 4 GiB of memory is the practical floor."
  type        = string
  default     = "t3.medium"

  validation {
    condition     = can(regex("^(t3|t3a|m5|m6i|m7i|c6i|c7i)\\.", var.instance_type))
    error_message = "Use an x86_64 family (the bootstrap installs the linux-x64 Node.js build)."
  }
}

variable "root_volume_gib" {
  description = "Encrypted gp3 root volume size. Holds Node.js, Chromium, dependencies and one runtime workspace per attempt (~0.12 GiB each; 264 attempts for pilots plus ten blocks). Grow a live runner with bin/grow-disk, not apply."
  type        = number
  default     = 80

  validation {
    condition     = var.root_volume_gib >= 20 && var.root_volume_gib <= 200
    error_message = "Use 20-200 GiB."
  }
}

variable "node_version" {
  description = "Node.js version installed on the runner. Must equal the benchmark's .node-version."
  type        = string
  default     = "22.23.4"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.node_version))
    error_message = "Use an exact version such as 22.23.4."
  }
}

variable "vpc_cidr" {
  description = "CIDR for the runner's dedicated VPC (one public subnet, no NAT gateway)."
  type        = string
  default     = "10.80.0.0/24"
}

variable "force_destroy_bucket" {
  description = "Allow `terraform destroy` to delete the records bucket and every object version in it. Leave false until the records have been fetched and committed."
  type        = bool
  default     = false
}

variable "noncurrent_version_days" {
  description = "Days to keep overwritten object versions in the records bucket (records are re-synced throughout a campaign)."
  type        = number
  default     = 30
}
