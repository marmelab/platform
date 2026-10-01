#!/usr/bin/env bash
# Usage: upload.sh frontend|functions <upload_url>  (run from the project root)
# Packs the bundle with pack.sh and PUTs it to the pre-signed URL returned by create_deployment.
set -euo pipefail
kind="${1:?usage: upload.sh frontend|functions <upload_url>}"
url="${2:?missing upload_url}"
bundle="$("$(dirname "$0")/pack.sh" "$kind")"
trap 'rm -f "$bundle"' EXIT
echo "uploading $kind bundle ($(du -h "$bundle" | cut -f1 | tr -d ' '))" >&2
curl -fsS -X PUT --data-binary @"$bundle" -H 'content-type: application/gzip' "$url"
echo
