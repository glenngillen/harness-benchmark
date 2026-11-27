output "region" {
  description = "Region of the runner and bucket."
  value       = var.region
}

output "instance_id" {
  description = "Runner instance ID (the target for SSM sessions and commands)."
  value       = aws_instance.runner.id
}

output "bucket_name" {
  description = "Private records bucket: bundles/ (source in) and records/ (results out)."
  value       = aws_s3_bucket.records.bucket
}

output "account_id" {
  description = "Account the runner was created in (to confirm the right profile before destroying)."
  value       = data.aws_caller_identity.current.account_id
}

output "session_command" {
  description = "Open an interactive shell on the runner over Session Manager."
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.runner.id}"
}

output "codex_login_forward_command" {
  description = "Forward the Codex CLI's local login callback port from your machine to the runner (run in a second terminal while `codex login` waits)."
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.runner.id} --document-name AWS-StartPortForwardingSession --parameters '{\"portNumber\":[\"1455\"],\"localPortNumber\":[\"1455\"]}'"
}
