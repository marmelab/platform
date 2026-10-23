output "name_servers" {
  value       = var.create_zone ? aws_route53_zone.zone[0].name_servers : []
  description = "NS records to add at the parent zone for <domain> when create_zone is set"
}

output "public_ip" {
  value = aws_eip.platform.public_ip
}

output "instance_id" {
  value = aws_instance.platform.id
}

output "ssm_command" {
  description = "Shell on the VM without SSH (needs the Session Manager plugin of the AWS CLI)"
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.platform.id}"
}

# The contract with deploy/install.sh --env-file (infra/README.md): deploy/.env keys. Secrets inside: never printed
# by tofu apply, read it with `tofu output -raw env_file > infra.env` (then chmod 600). The same content is in the
# SSM parameter read by remote-install.sh on the VM.
output "env_file" {
  sensitive   = true
  description = "KEY=value lines for deploy/install.sh --env-file"
  value       = local.env_file
}

# Read by remote-install.sh
output "region" { value = var.region }
output "ssm_parameter" { value = aws_ssm_parameter.env_file.name }
output "platform_repo_url" { value = local.platform_repo_url }
output "platform_ref" { value = var.platform_ref }
