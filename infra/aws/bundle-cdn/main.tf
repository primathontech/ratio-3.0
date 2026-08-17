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

# ── IAM: the ECS task role reads+writes the bucket via the S3 API ────────────
# This is what makes onboarding work (admin-api publish + origin render). Objects are Get/Put/Delete;
# ListBucket on the bucket itself is ALSO required — a HeadObject on a not-yet-existing key returns
# AccessDenied (not 404) without it, which breaks publish. Attached inline to the shared ECS task role
# (origin + admin-api both run as it).
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
