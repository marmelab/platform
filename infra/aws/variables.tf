variable "domain" {
  type        = string
  description = "Platform domain: apps on <app>.<domain>, API on api.<domain>, Studio on <domain>"
}

variable "zone_name" {
  type        = string
  default     = null
  description = "Existing Route 53 hosted zone holding <domain>: the domain itself, or a parent (e.g. example.com for apps.example.com). Ignored when create_zone is set"
}

variable "create_zone" {
  type        = bool
  default     = false
  description = "Create the hosted zone for <domain> (the parent's DNS lives elsewhere): delegate it with the name_servers output"
}

variable "region" {
  type    = string
  default = "eu-west-3"
}

variable "name" {
  type        = string
  default     = "platform"
  description = "Prefix of the AWS resource names"
}

variable "instance_type" {
  type        = string
  default     = "t3.xlarge" # 16 GB: the Studio image build needs about 8 GB (INSTALL.md §2)
  description = "EC2 instance type"
}

variable "volume_gb" {
  type        = number
  default     = 100
  description = "Root volume size (images, databases, Storage files, local backups)"
}

variable "admin_cidrs" {
  type        = list(string)
  default     = []
  description = "CIDRs allowed on port 22. Empty: no SSH at all, administration through SSM Session Manager"
}

variable "backup_bucket" {
  type        = string
  default     = ""
  description = "S3 bucket name for the backups (bucket names are global). Empty: <name>-backups-<account id>"
}

variable "dmarc_email" {
  type        = string
  default     = ""
  description = "Mailbox for the DMARC aggregate reports (rua). Empty: the DMARC record is published without reports"
}

# Install values (optional): with them, the env file is complete and remote-install.sh needs no option.
variable "acme_email" {
  type        = string
  default     = ""
  description = "Let's Encrypt account email (ACME_EMAIL)"
}

variable "admin_email" {
  type        = string
  default     = ""
  description = "First platform admin (ADMIN_EMAIL)"
}

variable "github_org" {
  type        = string
  default     = ""
  description = "GitHub organization holding the company's platform repository: sets CI_ALLOWED_WORKFLOWS and the repository cloned by remote-install.sh"
}

variable "platform_repo" {
  type        = string
  default     = "platform"
  description = "Name of the company's platform repository in github_org (INSTALL.md §7)"
}

variable "platform_ref" {
  type        = string
  default     = "main"
  description = "Branch or tag of the platform repository that remote-install.sh installs on the VM. CI_ALLOWED_WORKFLOWS stays pinned to main"
}

variable "platform_repo_url" {
  type        = string
  default     = ""
  description = "Clone URL remote-install.sh uses on the VM. Empty: https://github.com/<github_org>/<platform_repo>.git; git@github.com:<org>/<repo>.git with a deploy key on the VM (README)"
}
