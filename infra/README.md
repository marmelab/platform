# Provisioning

The platform runs on one Linux VM with Docker (INSTALL.md §2) and needs three outside services: a DNS wildcard, an
SMTP relay and an S3-compatible bucket for the backups. How they are provisioned is the company's choice: a module
here per provider, or by hand. The contract with the installer is one env file, read by `deploy/install.sh --env-file`
(or exported in the environment), with the `deploy/.env` keys:

```
PLATFORM_DOMAIN=apps.example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_SENDER_EMAIL=noreply@apps.example.com
BACKUP_S3_ENDPOINT=https://s3.example.com
BACKUP_S3_BUCKET=example-platform-backups
BACKUP_S3_REGION=eu-west-3
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
```

Shell syntax (`KEY=value`, quote a value with spaces); every key is optional (no SMTP: sign-ups are confirmed without
email; no bucket: backups stay on the VM). The rest (ACME email, first admin, GitHub organization) is given to the
installer as options or in the same file (`ACME_EMAIL`, `ADMIN_EMAIL`, `CI_ALLOWED_WORKFLOWS`, INSTALL.md §5).

- [`aws/`](aws/README.md): OpenTofu module, EC2 + Route 53 + S3 + SES, outputs the file (`tofu output -raw env_file`).
- Another provider: a module in `infra/<provider>/` with the same `env_file` output, or the file written by hand.
  Nothing is shared between providers on purpose.
