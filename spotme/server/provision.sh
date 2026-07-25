#!/usr/bin/env bash
#
# Spot Me — provision the always-on peer on AWS, in one command.
#
# Everything the console would have you click through, done in a script you can
# read before it runs: key pair, firewall, instance, and the machine setup.
# Idempotent — run it twice and it adopts what already exists rather than
# building a second copy and a second bill.
#
#   ./provision.sh            create or adopt
#   ./provision.sh --destroy  give it all back
#
# Prerequisite (the one thing that cannot be scripted from here):
#
#   aws configure
#
# Needs an IAM user with EC2 rights. Run it yourself and paste the key at its
# prompts — never into a chat transcript, and never into a file anyone else
# will read.
#
# TLS note: this app REQUIRES https. Cameras, microphones and WebRTC are all
# refused on plain http, so an IP address alone is not enough. With no domain
# registered, the instance answers on <ip>.sslip.io — a public DNS service that
# resolves any embedded IP — which Let's Encrypt will happily certify. Swap in
# a real domain later by pointing an A record here and re-running certbot.

set -euo pipefail

# ── settings ────────────────────────────────────────────────────────────────
# t4g.small is ARM (Graviton): about half the price of the x86 equivalent for
# this workload, and an always-on peer is memory-bound rather than CPU-bound.
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
REGION="${AWS_REGION:-ap-south-1}"        # Mumbai — nearest to the test phones
NAME="${NAME:-spotme-peer}"
KEY_DIR="${KEY_DIR:-$HOME/.spotme}"
KEY_FILE="$KEY_DIR/$NAME.pem"
VOLUME_GB=20

# MSYS_NO_PATHCONV: Git Bash on Windows rewrites any argument that looks like a
# unix path into a Windows one before the process sees it, which silently turned
# the SSM parameter name into C:/Program Files/Git/aws/service/... and returned
# nothing. Harmless everywhere else.
aws_() { MSYS_NO_PATHCONV=1 aws --region "$REGION" "$@"; }

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── preflight ───────────────────────────────────────────────────────────────
command -v aws >/dev/null 2>&1 || die "AWS CLI not found. Install it, then run: aws configure"

ACCOUNT=$(aws_ sts get-caller-identity --query Account --output text 2>/dev/null) \
  || die "No AWS credentials. Run 'aws configure' first — see the header of this file."
say "AWS account $ACCOUNT, region $REGION"

# ── teardown ────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--destroy" ]]; then
  say "Destroying $NAME"
  ids=$(aws_ ec2 describe-instances \
    --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text)
  if [[ -n "$ids" ]]; then
    aws_ ec2 terminate-instances --instance-ids $ids >/dev/null
    echo "  terminating: $ids"
    aws_ ec2 wait instance-terminated --instance-ids $ids
  fi
  # The security group cannot be deleted until its instances are truly gone,
  # which is why this waits above rather than firing and hoping.
  aws_ ec2 delete-security-group --group-name "$NAME-sg" 2>/dev/null || true
  aws_ ec2 delete-key-pair --key-name "$NAME" 2>/dev/null || true
  say "Done. Nothing left billing."
  exit 0
fi

# ── key pair ────────────────────────────────────────────────────────────────
# AWS shows a private key exactly once, at creation. If the local copy is lost
# the pair is useless, so a missing file means recreating both halves.
if [[ -f "$KEY_FILE" ]] && aws_ ec2 describe-key-pairs --key-names "$NAME" >/dev/null 2>&1; then
  say "Key pair exists: $KEY_FILE"
else
  say "Creating key pair"
  aws_ ec2 delete-key-pair --key-name "$NAME" >/dev/null 2>&1 || true
  mkdir -p "$KEY_DIR"
  aws_ ec2 create-key-pair --key-name "$NAME" \
    --query 'KeyMaterial' --output text > "$KEY_FILE"
  chmod 600 "$KEY_FILE"      # ssh refuses a key any other account can read
  echo "  saved $KEY_FILE"
fi

# ── firewall ────────────────────────────────────────────────────────────────
VPC=$(aws_ ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
[[ "$VPC" != "None" ]] || die "No default VPC in $REGION."

if SG=$(aws_ ec2 describe-security-groups --group-names "$NAME-sg" \
        --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null); then
  say "Security group exists: $SG"
else
  say "Creating security group"
  SG=$(aws_ ec2 create-security-group --group-name "$NAME-sg" --vpc-id "$VPC" \
    --description "Spot Me always-on peer" --query 'GroupId' --output text)
  # 22 for deploys, 80 so Let's Encrypt can complete its challenge, 443 for the
  # app itself. Nothing else — the peer reaches out, it is not reached into.
  for port in 22 80 443; do
    aws_ ec2 authorize-security-group-ingress --group-id "$SG" \
      --protocol tcp --port "$port" --cidr 0.0.0.0/0 >/dev/null
  done
  echo "  $SG — open on 22, 80, 443"
fi

# ── instance ────────────────────────────────────────────────────────────────
EXISTING=$(aws_ ec2 describe-instances \
  --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running" \
  --query 'Reservations[].Instances[0].InstanceId' --output text)

if [[ -n "$EXISTING" && "$EXISTING" != "None" ]]; then
  say "Instance already running: $EXISTING"
  ID="$EXISTING"
else
  # Ask AWS for the current Amazon Linux 2023 ARM image rather than pinning an
  # AMI id: they are per-region and go stale, and a wrong one fails cryptically.
  say "Finding the latest Amazon Linux 2023 (arm64) image"
  AMI=$(aws_ ssm get-parameters \
    --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
    --query 'Parameters[0].Value' --output text)
  [[ "$AMI" == ami-* ]] || die "AMI lookup failed (got '$AMI'). SSM may be unreachable, or the parameter name is wrong for this region."
  echo "  $AMI"

  say "Launching $INSTANCE_TYPE"
  ID=$(aws_ ec2 run-instances \
    --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
    --key-name "$NAME" --security-group-ids "$SG" \
    --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=$VOLUME_GB,VolumeType=gp3,DeleteOnTermination=true}" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
    --metadata-options "HttpTokens=required" \
    --query 'Instances[0].InstanceId' --output text)
  echo "  $ID"
  aws_ ec2 wait instance-running --instance-ids "$ID"
fi

IP=$(aws_ ec2 describe-instances --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
HOST="${IP//./-}.sslip.io"

say "Waiting for SSH"
for i in $(seq 1 40); do
  if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes \
       -i "$KEY_FILE" "ec2-user@$IP" true 2>/dev/null; then
    echo "  up after ~$((i * 5))s"; break
  fi
  [[ $i -eq 40 ]] && die "SSH never came up. Check the security group and instance state."
  sleep 5
done

say "Configuring the machine"
scp -o StrictHostKeyChecking=no -i "$KEY_FILE" \
  "$(dirname "$0")/bootstrap.sh" "ec2-user@$IP:/tmp/bootstrap.sh"
ssh -o StrictHostKeyChecking=no -i "$KEY_FILE" "ec2-user@$IP" \
  "chmod +x /tmp/bootstrap.sh && sudo /tmp/bootstrap.sh '$HOST'"

cat <<EOF

  ────────────────────────────────────────────────────────────
   Ready.

   Address    https://$HOST
   SSH        ssh -i $KEY_FILE ec2-user@$IP
   Deploy     ./deploy.sh
   Destroy    ./provision.sh --destroy

   Cost is roughly \$12/month at on-demand rates, covered by credits
   while they last. --destroy stops it billing entirely.
  ────────────────────────────────────────────────────────────

EOF
