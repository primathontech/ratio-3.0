variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "environment" {
  type    = string
  default = "staging"
}

# ECS task role NAMES (not ARNs) for the admin-api + origin tasks, granted S3 read/write on the
# bucket. Find them on each task definition's taskRoleArn. Leave empty to skip the attachment and
# wire IAM yourself.
variable "task_role_names" {
  type    = list(string)
  default = []
}
