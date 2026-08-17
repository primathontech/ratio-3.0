output "bucket_name" {
  value = aws_s3_bucket.bundles.bucket
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.bundles.domain_name
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.bundles.id
}

# Copy these onto the admin-api + origin ECS task defs.
output "task_def_env" {
  value = {
    BUNDLE_S3_BUCKET = aws_s3_bucket.bundles.bucket
    BUNDLE_S3_REGION = var.region
  }
}

output "cloudfront_read_url" {
  description = "Base URL for reading bundle objects via the CDN (used once the origin reads via CloudFront)."
  value       = "https://${aws_cloudfront_distribution.bundles.domain_name}"
}

# Dedicated per-app ECS task role ARNs (OFCE-620). Set these as the repo variables
# ORIGIN_TASK_ROLE_ARN / ADMIN_TASK_ROLE_ARN so the deploy points each service at its own role.
output "origin_task_role_arn" {
  value = aws_iam_role.origin_task.arn
}

output "admin_api_task_role_arn" {
  value = aws_iam_role.admin_api_task.arn
}
