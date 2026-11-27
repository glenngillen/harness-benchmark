terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.40.0, < 7.0.0"
    }
  }

  # Local state on purpose: this is a short-lived, single-operator runner. Keep the state file
  # until `terraform destroy` has finished; it is gitignored (runner/aws/.gitignore).
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "harness-benchmark"
      ManagedBy = "terraform"
      Purpose   = "benchmark-runner"
    }
  }
}
