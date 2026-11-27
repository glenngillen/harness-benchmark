# One EC2 Linux runner for the harness benchmark, reached only through SSM Session Manager (no SSH
# key, no inbound rule), plus a private versioned bucket that carries source bundles in and records
# out. See ../README.md. The building loop writes this configuration but never applies it.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

# Canonical's published Ubuntu 24.04 LTS AMI for x86_64. The SSM agent is preinstalled, and
# bubblewrap is in the main archive.
data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  bucket_arn = aws_s3_bucket.records.arn
}

# ---------------------------------------------------------------------------------------------
# Network: a dedicated VPC with one public subnet. Outbound only (model APIs, npm, apt, SSM, S3);
# the security group has no ingress rules. No NAT gateway, so no hourly NAT charge.
# ---------------------------------------------------------------------------------------------

resource "aws_vpc" "runner" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.name_prefix}-vpc" }
}

resource "aws_internet_gateway" "runner" {
  vpc_id = aws_vpc.runner.id

  tags = { Name = "${var.name_prefix}-igw" }
}

resource "aws_subnet" "runner" {
  vpc_id                  = aws_vpc.runner.id
  cidr_block              = var.vpc_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = { Name = "${var.name_prefix}-public" }
}

resource "aws_route_table" "runner" {
  vpc_id = aws_vpc.runner.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.runner.id
  }

  tags = { Name = "${var.name_prefix}-public" }
}

resource "aws_route_table_association" "runner" {
  subnet_id      = aws_subnet.runner.id
  route_table_id = aws_route_table.runner.id
}

resource "aws_security_group" "runner" {
  name        = "${var.name_prefix}-runner"
  description = "Harness benchmark runner: no inbound access; outbound HTTP(S) only"
  vpc_id      = aws_vpc.runner.id

  tags = { Name = "${var.name_prefix}-runner" }
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.runner.id
  description       = "HTTPS: model APIs, npm, Node.js downloads, SSM, S3"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "http" {
  security_group_id = aws_security_group.runner.id
  description       = "HTTP: Ubuntu package mirrors (packages are signature-checked by apt)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

# ---------------------------------------------------------------------------------------------
# Records bucket: private, versioned, encrypted, TLS only.
# ---------------------------------------------------------------------------------------------

resource "aws_s3_bucket" "records" {
  bucket_prefix = "${var.name_prefix}-records-"
  force_destroy = var.force_destroy_bucket

  tags = { Name = "${var.name_prefix}-records" }
}

resource "aws_s3_bucket_public_access_block" "records" {
  bucket                  = aws_s3_bucket.records.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "records" {
  bucket = aws_s3_bucket.records.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "records" {
  bucket = aws_s3_bucket.records.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "records" {
  bucket = aws_s3_bucket.records.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "records" {
  bucket = aws_s3_bucket.records.id

  rule {
    id     = "expire-overwritten-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.records]
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      local.bucket_arn,
      "${local.bucket_arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "records" {
  bucket = aws_s3_bucket.records.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.records]
}

# ---------------------------------------------------------------------------------------------
# Instance role: SSM Session Manager / Run Command, read bundles, write records. Nothing else.
# ---------------------------------------------------------------------------------------------

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "runner" {
  name_prefix        = "${var.name_prefix}-runner-"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.runner.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "runner_bucket" {
  statement {
    sid       = "ListOwnPrefixes"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["bundles/*", "records/*", "records/"]
    }
  }

  statement {
    sid       = "ReadBundles"
    actions   = ["s3:GetObject"]
    resources = ["${local.bucket_arn}/bundles/*"]
  }

  statement {
    sid       = "WriteRecords"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${local.bucket_arn}/records/*"]
  }
}

resource "aws_iam_role_policy" "runner_bucket" {
  name   = "records-bucket"
  role   = aws_iam_role.runner.id
  policy = data.aws_iam_policy_document.runner_bucket.json
}

resource "aws_iam_instance_profile" "runner" {
  name_prefix = "${var.name_prefix}-runner-"
  role        = aws_iam_role.runner.name
}

# ---------------------------------------------------------------------------------------------
# The runner instance.
# ---------------------------------------------------------------------------------------------

resource "aws_instance" "runner" {
  ami                    = data.aws_ssm_parameter.ubuntu.insecure_value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.runner.id
  vpc_security_group_ids = [aws_security_group.runner.id]
  iam_instance_profile   = aws_iam_instance_profile.runner.name

  # IMDSv2 only. The bootstrap additionally blocks the metadata endpoint for every non-root user,
  # so model stages (which run as the unprivileged `bench` user) cannot obtain the role credentials.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gib
    encrypted             = true
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    bootstrap_gz_b64 = base64gzip(file("${path.module}/../remote/bootstrap.sh"))
    node_version     = var.node_version
    bucket           = aws_s3_bucket.records.bucket
    region           = var.region
  })
  user_data_replace_on_change = true

  tags = { Name = "${var.name_prefix}-runner" }

  lifecycle {
    # A newer Ubuntu AMI must not replace the instance (and its logins and runtime state) mid-campaign.
    # user_data too: with user_data_replace_on_change, any later edit to remote/bootstrap.sh would
    # otherwise replace the runner (and its logins, records and host identity) on the next apply.
    # A release installs scripts from the bundle; bootstrap changes reach a live runner by hand.
    ignore_changes = [ami, user_data]
  }

  depends_on = [aws_iam_role_policy.runner_bucket, aws_iam_role_policy_attachment.ssm_core]
}
