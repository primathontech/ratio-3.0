terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
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
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "bundles" {
  enabled     = true
  comment     = "Ratio 3.0 bundle themes (${var.environment})"
  price_class = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.bundles.bucket_regional_domain_name
    origin_id                = "bundles-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.bundles.id
  }

  default_cache_behavior {
    target_origin_id       = "bundles-s3"
    viewer_protocol_policy  = "redirect-to-https"
    allowed_methods         = ["GET", "HEAD"]
    cached_methods          = ["GET", "HEAD"]
    compress                = true
    cache_policy_id         = "658327ea-f89d-4fab-a63d-7e88639e58f6" # AWS-managed CachingOptimized
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
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

# ── IAM: the ECS task role(s) read+write the bucket via the S3 API ───────────
# This is what actually makes onboarding work today (admin-api publish + origin render). Minimal
# actions — the code only uses Get/Put/Delete (+ Head, covered by Get); it never lists.
data "aws_iam_policy_document" "task" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.bundles.arn}/*"]
  }
}

resource "aws_iam_policy" "task" {
  name   = "ratio3-bundle-store-${var.environment}"
  policy = data.aws_iam_policy_document.task.json
}

resource "aws_iam_role_policy_attachment" "task" {
  for_each   = toset(var.task_role_names)
  role       = each.value
  policy_arn = aws_iam_policy.task.arn
}
