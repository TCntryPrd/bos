#!/bin/bash
# Deploy IR Custom AIOS White-Label for Kane Minkus (IR)
# Target: Hostinger VPS (ircustomdashboards.tech)
# Date: 2026-06-05

set -e

echo "=== IR Custom AIOS IR White-Label Deployment Script ==="
echo "Target: ircustomdashboards.tech"
echo "Mode: Clean install - no personal data"
echo ""

# Generate fresh encryption keys
echo "Generating fresh encryption keys..."
ENCRYPTION_KEY=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)

echo "Keys generated (save these securely):"
echo "BOSS_TOKEN_ENCRYPTION_KEY=$ENCRYPTION_KEY"
echo "JWT_SECRET=$JWT_SECRET"
echo ""

# Create deployment directory
DEPLOY_DIR="/tmp/boss-ir-deploy-$(date +%Y%m%d-%H%M%S)"
echo "Creating deployment package at: $DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"

# Copy codebase (excluding personal data)
echo "Copying codebase..."
rsync -av --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='dist' \
  --exclude='*.log' \
  --exclude='transcripts' \
  --exclude='/home' \
  . "$DEPLOY_DIR/"

# Copy clean env template and inject generated keys
echo "Configuring environment..."
cp .env.ir-whitelabel "$DEPLOY_DIR/.env"
sed -i "s/GENERATE_NEW_KEY_HERE/$ENCRYPTION_KEY/g" "$DEPLOY_DIR/.env"
sed -i "s/CHANGE_ME/$(openssl rand -hex 16)/g" "$DEPLOY_DIR/.env"

# Update JWT secret
sed -i "0,/GENERATE_NEW_KEY_HERE/s//$JWT_SECRET/" "$DEPLOY_DIR/.env"

# Build the application
echo "Building application..."
cd "$DEPLOY_DIR"
npm install --legacy-peer-deps

# Build packages in dependency order
echo "Building packages/core..."
npm run build --workspace=packages/core

echo "Building packages/brain..."
npm run build --workspace=packages/brain

echo "Building packages/connectors..."
npm run build --workspace=packages/connectors

echo "Building apps/web..."
npm run build --workspace=apps/web

echo "Building apps/api..."
npm run build --workspace=apps/api

echo ""
echo "=== Deployment package ready at: $DEPLOY_DIR ==="
echo ""
echo "Next steps:"
echo "1. SCP the deployment package to Hostinger:"
echo "   scp -r $DEPLOY_DIR root@2.24.116.75:/docker/boss-ir/"
echo ""
echo "2. SSH to Hostinger and setup:"
echo "   ssh root@2.24.116.75"
echo "   cd /docker/boss-ir"
echo "   docker compose up -d"
echo ""
echo "3. Verify /install page:"
echo "   https://ircustomdashboards.tech/install"
echo ""
echo "=== Credentials for Kane ==="
echo "Save these securely - Kane will need them:"
echo ""
echo "BOSS_TOKEN_ENCRYPTION_KEY=$ENCRYPTION_KEY"
echo "JWT_SECRET=$JWT_SECRET"
echo ""
