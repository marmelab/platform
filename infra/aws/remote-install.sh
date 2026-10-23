#!/usr/bin/env bash
# Install the platform on the VM, or re-run the installer, through SSM Run Command (no SSH, no shell session):
#   infra/aws/remote-install.sh [deploy/install.sh options, e.g. --acme-ca https://acme-staging-v02.api.letsencrypt.org/directory]
# Run after `tofu apply` from any directory. On the VM, as root: the env file is read from the SSM parameter (the
# instance role may read that one parameter), the platform repository is cloned at platform_ref into /opt/platform
# (or updated to it), then `deploy/install.sh --production --non-interactive --env-file /root/infra.env`. The
# installer's output is printed at the end (SSM keeps its last 24 000 characters; the full log is /root/install.log
# on the VM). The admin credentials stay on the VM, in /opt/platform/deploy/.env.local.
set -euo pipefail
cd "$(dirname "$0")"
out() { tofu output -raw "$1"; }
REGION=$(out region) INSTANCE=$(out instance_id) PARAM=$(out ssm_parameter) REPO=$(out platform_repo_url) REF=$(out platform_ref)
OPTIONS=$(printf '%q ' "$@") # installer options, quoted for the remote bash (a space or a shell character survives)

# AWS-RunShellScript runs the commands with sh: the script is written to the VM and run with bash
SCRIPT="cat > /root/remote-install.sh <<'PLATFORM_EOF'
export PATH=\$PATH:/snap/bin DEBIAN_FRONTEND=noninteractive
command -v aws >/dev/null || snap install aws-cli --classic
# ponytail: the snap aws, started by the SSM agent (a snap too), writes nothing when stdout is a file; a pipe works
aws ssm get-parameter --region $REGION --with-decryption --name $PARAM --query Parameter.Value --output text | cat > /root/infra.env
[ -s /root/infra.env ] || { echo \"env file not read from $PARAM\" >&2; exit 1; }
chmod 600 /root/infra.env
if [ -d /opt/platform/.git ]; then git -C /opt/platform fetch -q origin $REF && git -C /opt/platform checkout -q --detach FETCH_HEAD
else git clone -q -b $REF $REPO /opt/platform; fi
cd /opt/platform && deploy/install.sh --production --non-interactive --env-file /root/infra.env $OPTIONS 2>&1 | tee /root/install.log
PLATFORM_EOF
bash -euo pipefail /root/remote-install.sh"
PARAMS=$(python3 -c 'import json,sys; print(json.dumps({"commands":[sys.argv[1]],"executionTimeout":["7200"]}))' "$SCRIPT")

ID=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --comment "platform install" --parameters "$PARAMS" --query Command.CommandId --output text)
echo "install started on $INSTANCE (command $ID), the first run takes several minutes..."
while :; do
  STATUS=$(aws ssm get-command-invocation --region "$REGION" --command-id "$ID" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case "$STATUS" in Pending|InProgress|Delayed) sleep 10 ;; *) break ;; esac
done
aws ssm get-command-invocation --region "$REGION" --command-id "$ID" --instance-id "$INSTANCE" \
  --query '[StandardOutputContent,StandardErrorContent]' --output text
echo "status: $STATUS"
[ "$STATUS" = Success ]
