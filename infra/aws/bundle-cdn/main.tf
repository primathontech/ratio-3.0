terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # Remote state (created out-of-band): versioned S3 bucket + DynamoDB lock. Backend blocks CANNOT
  # interpolate var.environment, so the key is a hardcoded literal — a staging/prod stack MUST edit
  # this key (e.g. bundle-cdn/staging/…) and `terraform init -reconfigure` before applying, or it
  # would clobber dev's state while creating differently-named resources.
  backend "s3" {
    bucket         = "ratio3-tf-state"
    key            = "bundle-cdn/dev/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "ratio3-tf-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region
}

locals {
  bucket = "ratio3-theme-bundles-${var.environment}"
}

# ── Private bucket for compiled bundle themes ────────────────────────────────
# Content-hash keys (immutable). Read/written server-side by admin-api (publish) and origin (render)
# via the S3 API using the ECS task role; never public.
resource "aws_s3_bucket" "bundles" {
  bucket = local.bucket

  # Holds every store's live theme bundles — a destroy/replace would drop all published themes.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "bundles" {
  bucket                  = aws_s3_bucket.bundles.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "bundles" {
  bucket = aws_s3_bucket.bundles.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ── CloudFront: read CDN over the private bucket (Origin Access Control) ──────
# Keys are immutable content hashes → the managed "CachingOptimized" policy (long TTL) is safe with
# zero invalidation: a new publish is a new key, so the CDN can never serve stale. Writes never go
# through CloudFront — publish is a direct S3 PutObject via the task role.
resource "aws_cloudfront_origin_access_control" "bundles" {
  name                              = "${local.bucket}-oac"
  description                       = "OAC for ratio3 bundle themes (${var.environment})"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "bundles" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "Ratio 3.0 bundle themes (${var.environment})"
  price_class     = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.bundles.bucket_regional_domain_name
    origin_id                = "bundles-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.bundles.id
  }

  default_cache_behavior {
    target_origin_id       = "bundles-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6" # AWS-managed CachingOptimized
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  # The store CDN domain is baked into origins' BUNDLE_CDN_URL — a replace would change it + break reads.
  lifecycle {
    prevent_destroy = true
  }
}

# ── Bucket policy: only THIS CloudFront distribution may read (via OAC) ───────
data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "AllowCloudFrontOAC"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.bundles.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.bundles.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "bundles" {
  bucket = aws_s3_bucket.bundles.id
  policy = data.aws_iam_policy_document.bucket.json
}

# ── IAM (LEGACY, retiring in OFCE-620 Phase 3): shared inline policy on the execution role ───
# The bundle S3 grant was attached inline to ecsTaskExecutionRole (reused as both execution AND task
# role by origin + admin-api). Kept ONLY until both services cut over to their own task roles below;
# removed once they have. ListBucket is required — a HeadObject on a missing key 403s without it.
data "aws_iam_policy_document" "task" {
  statement {
    sid       = "BundleStoreObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.bundles.arn}/*"]
  }
  statement {
    sid       = "BundleStoreListForHead"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.bundles.arn]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "ratio3-bundle-store-${var.environment}"
  role   = var.task_role_name
  policy = data.aws_iam_policy_document.task.json
}

# ── Dedicated per-app task roles (OFCE-620): least-privilege, split off the shared exec role ──
# origin only READS bundles (render); admin-api also WRITES (publish). Each service runs as its OWN
# task role so the S3 grant is scoped to exactly what it needs, and ecsTaskExecutionRole goes back to
# execution-only (image pull + logs). Trust is scoped to this account (confused-deputy guard).
data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# origin: READ-only (Get + List)
data "aws_iam_policy_document" "origin_task" {
  statement {
    sid       = "BundleStoreRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.bundles.arn}/*"]
  }
  statement {
    sid       = "BundleStoreList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.bundles.arn]
  }
}

resource "aws_iam_role" "origin_task" {
  name               = "ratio3-origin-task-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "origin_task" {
  name   = "bundle-store-read"
  role   = aws_iam_role.origin_task.id
  policy = data.aws_iam_policy_document.origin_task.json
}

# admin-api: READ-WRITE (Get/Put/Delete + List)
data "aws_iam_policy_document" "admin_api_task" {
  statement {
    sid       = "BundleStoreObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.bundles.arn}/*"]
  }
  statement {
    sid       = "BundleStoreList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.bundles.arn]
  }
}

resource "aws_iam_role" "admin_api_task" {
  name               = "ratio3-admin-api-task-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "admin_api_task" {
  name   = "bundle-store-rw"
  role   = aws_iam_role.admin_api_task.id
  policy = data.aws_iam_policy_document.admin_api_task.json
}
