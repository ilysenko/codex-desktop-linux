#!/bin/bash
set -Eeuo pipefail

feature_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$feature_dir/catalog.js" "${PACKAGE_APP_DIR:?Package staging app directory is required}"
