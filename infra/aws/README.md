# Platform infrastructure on AWS (OpenTofu)

One VM (Ubuntu 24.04, Docker, Elastic IP, 80/443 open, SSM Session Manager), the wildcard DNS record in Route 53, a
private versioned S3 bucket for the backups with a user limited to it, and Amazon SES as the SMTP relay (domain
identity with DKIM and a custom MAIL FROM, a user limited to sending from that identity). The module writes nothing on
the VM beyond its boot script (`user-data.sh`): the platform is installed afterwards by `remote-install.sh` (below)
or by hand, INSTALL.md §5.

```bash
aws login                               # or any credentials the AWS CLI accepts
cd infra/aws
cp terraform.tfvars.example terraform.tfvars   # domain, hosted zone, region, install values
tofu init && tofu apply
```

Then install the platform on the VM without opening a shell, from this machine:

```bash
./remote-install.sh        # options of deploy/install.sh accepted, e.g. --acme-ca <staging URL> for a first try
```

It runs, through SSM Run Command as root on the VM: fetch the env file from the SSM parameter `/<name>/env-file`
(a SecureString holding the `env_file` output, which the instance role alone may read), clone the company's
platform repository (`github_org`/`platform_repo` at `platform_ref`) into `/opt/platform`, and
`deploy/install.sh --production --non-interactive --env-file /root/infra.env`. With `acme_email`, `admin_email` and
`github_org` set in the tfvars, the env file carries every value and the installer asks nothing. Re-run it to re-apply
the installer at `platform_ref`; a code change goes through `deploy/upgrade.sh` instead
([Updating the platform](#updating-the-platform)). `platform_ref` only pins what the VM runs: the workflow the
platform accepts from CI (`CI_ALLOWED_WORKFLOWS`) is always `deploy.yml@refs/heads/main` of the company copy, so a VM
on a branch or tag still deploys through the workflow and CLI of `main`. The admin password stays on the VM
(`/opt/platform/deploy/.env.local`): read it in a session ([Session on the VM](#session-on-the-vm)).

The clone runs without credentials. An internal or private platform repository (INSTALL.md §7, the usual case) needs
a read-only deploy key on the VM before the first run: generate one, add its public half to the repository
(Settings > Deploy keys), in a session put the private half in `/root/.ssh/id_ed25519` and run
`ssh-keyscan github.com >> /root/.ssh/known_hosts`, then set `platform_repo_url = "git@github.com:<org>/<repo>.git"`
in the tfvars so the clone goes through SSH.
Without a key: install by hand (below).

By hand instead: `tofu output -raw env_file > infra.env && chmod 600 infra.env` gives the same file (the contract,
[infra/README.md](../README.md)); copy it to the VM as `/root/infra.env` and follow INSTALL.md §5 with
`--env-file /root/infra.env`.

Prerequisites: a hosted zone in Route 53 for the domain or a parent of it (`zone_name`), and a default VPC in the
region (the VM goes in its first subnet). When the parent's DNS is managed elsewhere (another registrar, Cloudflare),
set `create_zone = true` instead of `zone_name`: the module creates the zone for the domain and `tofu output
name_servers` prints its four name servers; add them as `NS` records for the domain at the parent (TTL as you like),
once. The platform's records, SES verification and Let's Encrypt all wait for that delegation
(`dig NS apps.example.com` answers with the Route 53 servers once it is in place).

The state file holds the IAM keys and the SMTP password in clear: it is gitignored; keep it on the admin's machine or
move it to a private bucket (the commented `backend "s3"` block).

## Session on the VM

`tofu output ssm_command` only prints the command; run it with:

```bash
eval "$(tofu output -raw ssm_command)"   # shell as ssm-user; `sudo -i` for root (/opt/platform belongs to root)
```

It needs the Session Manager plugin of the AWS CLI and the IAM action `ssm:StartSession` on the instance, which
`remote-install.sh` does not use (it only needs `ssm:SendCommand` and `ssm:GetCommandInvocation`): a user who can run
`remote-install.sh` may still be refused a session.

## Updating the platform

Merge the change to the company copy's `main` (or the branch or tag `platform_ref` names). A change to the plugin or to
`.github/workflows/deploy.yml` needs nothing more: CI runs the workflow of `main`, and builders get the plugin from
the marketplace. A change to what runs on the VM is applied in a session, as root, with the upgrade script
(INSTALL.md §11: app backups, rollback image tags, app recycling without downtime, verification):

```bash
cd /opt/platform && git fetch -q origin main && git checkout -q --detach FETCH_HEAD
deploy/upgrade.sh                                 # asks for confirmation; rollback: deploy/upgrades/<timestamp>/ROLLBACK.md
```

`./remote-install.sh` from the admin's machine also moves the VM to `platform_ref`, without a session, but re-runs the
installer instead: none of the upgrade script's backups, rollback tags or verification. Keep it for the first install
and for a change of the installer's values.

## SES sandbox

A new account only delivers to verified addresses. Request production access once (AWS answers by email, usually
within a day), and verify the test recipients meanwhile:

```bash
aws sesv2 put-account-details --region eu-west-3 --production-access-enabled --mail-type TRANSACTIONAL \
  --website-url https://apps.example.com --contact-language EN \
  --use-case-description "Transactional email of an internal app hosting platform: account welcome, sign-up confirmation, password reset and invitations for the company's internal apps. Low volume, no marketing."
aws sesv2 create-email-identity --region eu-west-3 --email-identity someone@example.com   # a test recipient
aws sesv2 get-email-identity --region eu-west-3 --email-identity apps.example.com \
  --query '[VerifiedForSendingStatus,DkimAttributes.Status]'                               # DNS verification, a few minutes
```

## Not covered

EBS snapshots of the VM (add an AWS Backup or DLM policy: the platform only dumps its own databases to S3), a
non-default VPC, a domain whose zone cannot be delegated to Route 53 (create the records of `main.tf` by hand),
IPv6.
