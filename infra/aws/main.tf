# The platform's infrastructure on AWS (docs/INSTALL.md §2b): one VM with Docker, a wildcard DNS record, an S3 bucket
# for the backups and Amazon SES as the SMTP relay. `tofu output -raw env_file` is what deploy/install.sh --env-file
# reads; the platform itself is installed on the VM by hand (INSTALL.md §5). Other providers: infra/README.md.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  # The state holds the IAM keys and the SMTP password in clear: keep it on the admin's machine (default, gitignored)
  # or in a private bucket:
  # backend "s3" {
  #   bucket  = "<state bucket>"
  #   key     = "platform/terraform.tfstate"
  #   region  = "eu-west-3"
  #   encrypt = true
  # }
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}

# The hosted zone: an existing one (zone_name), or a new zone for <domain> when create_zone is set: delegate it
# at the parent with the name_servers output.
data "aws_route53_zone" "zone" {
  count = var.create_zone ? 0 : 1
  name  = var.zone_name
}

resource "aws_route53_zone" "zone" {
  count = var.create_zone ? 1 : 0
  name  = var.domain
  tags  = { Name = var.name }
}

locals {
  zone_id = var.create_zone ? aws_route53_zone.zone[0].zone_id : data.aws_route53_zone.zone[0].zone_id
}

# --- VM: Ubuntu 24.04, Elastic IP, 80/443 open, SSM Session Manager for administration -----------------------------
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "web" {
  name        = "${var.name}-web"
  description = "Platform VM: HTTPS and the ACME HTTP challenge from everywhere, SSH from the admin addresses only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
  ingress {
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
  dynamic "ingress" {
    for_each = length(var.admin_cidrs) > 0 ? [1] : []
    content {
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.admin_cidrs
    }
  }
  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

resource "aws_iam_role" "instance" {
  name = "${var.name}-instance"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# The VM may read its own env file (remote-install.sh), nothing else
resource "aws_iam_role_policy" "env_file" {
  name = "read-env-file"
  role = aws_iam_role.instance.name
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "ssm:GetParameter", Resource = aws_ssm_parameter.env_file.arn }]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
}

resource "aws_instance" "platform" {
  ami                     = data.aws_ami.ubuntu.id
  instance_type           = var.instance_type
  subnet_id               = data.aws_subnets.default.ids[0]
  vpc_security_group_ids  = [aws_security_group.web.id]
  iam_instance_profile    = aws_iam_instance_profile.instance.name
  user_data               = file("${path.module}/user-data.sh")
  disable_api_termination = true

  root_block_device {
    volume_size = var.volume_gb
    volume_type = "gp3"
    encrypted   = true
  }
  metadata_options {
    http_tokens = "required" # IMDSv2
  }
  tags = { Name = var.name }

  lifecycle {
    ignore_changes = [ami, user_data] # a newer image must never replace the running platform
  }
}

resource "aws_eip" "platform" {
  domain = "vpc"
  tags   = { Name = var.name }
}

resource "aws_eip_association" "platform" {
  instance_id   = aws_instance.platform.id
  allocation_id = aws_eip.platform.id
}

# --- DNS: the wildcard covers api., admin., studio. and every app (INSTALL.md §3) ---------------------------------
resource "aws_route53_record" "wildcard" {
  zone_id = local.zone_id
  name    = "*.${var.domain}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.platform.public_ip]
}

resource "aws_route53_record" "apex" {
  zone_id = local.zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.platform.public_ip]
}

# --- Backups: a private, versioned bucket and a user that can only use it (INSTALL.md §9) -------------------------
locals {
  bucket = var.backup_bucket != "" ? var.backup_bucket : "${var.name}-backups-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "backups" {
  bucket = local.bucket
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

# The platform's retention deletes expired backups (backups.ts); on a versioned bucket that only adds a delete marker,
# so the old versions are expired here after a grace period (an accidental delete is undone within it), and the
# markers with them. Without this rule every backup ever taken stays forever.
resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket     = aws_s3_bucket.backups.id
  depends_on = [aws_s3_bucket_versioning.backups]
  rule {
    id     = "expire-deleted-backups"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    expiration {
      expired_object_delete_marker = true
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_iam_user" "backups" {
  name = "${var.name}-backups"
}

resource "aws_iam_user_policy" "backups" {
  name = "backups-bucket"
  user = aws_iam_user.backups.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.backups.arn}/*" },
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.backups.arn },
    ]
  })
}

resource "aws_iam_access_key" "backups" {
  user = aws_iam_user.backups.name
}

# --- Mail: SES domain identity (any address on the domain can send), DKIM, custom MAIL FROM for SPF, SMTP user -----
# The account starts in the SES sandbox (mail to verified recipients only): see README.md for the production access
# request, which is not a resource.
resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain
}

resource "aws_route53_record" "dkim" {
  count   = 3
  zone_id = local.zone_id
  name    = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = "mail.${var.domain}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "mail_from_mx" {
  zone_id = local.zone_id
  name    = "mail.${var.domain}"
  type    = "MX"
  ttl     = 1800
  records = ["10 feedback-smtp.${var.region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  zone_id = local.zone_id
  name    = "mail.${var.domain}"
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_iam_user" "smtp" {
  name = "${var.name}-ses-smtp"
}

resource "aws_iam_user_policy" "smtp" {
  name = "ses-send"
  user = aws_iam_user.smtp.name
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "ses:SendRawEmail", Resource = aws_sesv2_email_identity.domain.arn }]
  })
}

resource "aws_iam_access_key" "smtp" {
  user = aws_iam_user.smtp.name
}

# --- Install: the env file of deploy/install.sh --env-file, as a SecureString the VM reads (remote-install.sh) ------
locals {
  platform_repo_url = var.platform_repo_url != "" ? var.platform_repo_url : "https://github.com/${var.github_org}/${var.platform_repo}.git"
  # Always main, whatever platform_ref: the workflow the platform accepts from CI is pinned to the default branch of
  # the company copy; platform_ref only chooses what the VM runs (README)
  ci_allowed        = var.github_org != "" ? "${var.github_org}/${var.platform_repo}/.github/workflows/deploy.yml@refs/heads/main" : ""
  env_file = join("\n", concat([
    "PLATFORM_DOMAIN=${var.domain}",
    "SMTP_HOST=email-smtp.${var.region}.amazonaws.com",
    "SMTP_PORT=587",
    "SMTP_USER=${aws_iam_access_key.smtp.id}",
    "SMTP_PASSWORD=${aws_iam_access_key.smtp.ses_smtp_password_v4}",
    "SMTP_SENDER_EMAIL=noreply@${var.domain}",
    "BACKUP_S3_ENDPOINT=https://s3.${var.region}.amazonaws.com",
    "BACKUP_S3_BUCKET=${aws_s3_bucket.backups.bucket}",
    "BACKUP_S3_REGION=${var.region}",
    "BACKUP_S3_ACCESS_KEY_ID=${aws_iam_access_key.backups.id}",
    "BACKUP_S3_SECRET_ACCESS_KEY=${aws_iam_access_key.backups.secret}",
    ],
    var.acme_email != "" ? ["ACME_EMAIL=${var.acme_email}"] : [],
    var.admin_email != "" ? ["ADMIN_EMAIL=${var.admin_email}"] : [],
    local.ci_allowed != "" ? ["CI_ALLOWED_WORKFLOWS=${local.ci_allowed}"] : [],
    [""],
  ))
}

resource "aws_ssm_parameter" "env_file" {
  name  = "/${var.name}/env-file"
  type  = "SecureString"
  value = local.env_file
  tags  = { Name = var.name }
}
