#!/usr/bin/env bash
# Check dependencies for github-push skill
# Usage: bash .agent/skills/github-push/scripts/setup.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "Checking dependencies for GitHub push..."
echo "------------------------------------------"

# Check git
if command -v git &> /dev/null; then
    GIT_VERSION=$(git --version)
    echo -e "${GREEN}✓${NC} git: ${GIT_VERSION}"
else
    echo -e "${RED}✗${NC} git: not found"
    echo -e "${YELLOW}Install: winget install Git.Git${NC} (Windows) or brew install git (macOS)"
    exit 1
fi

# Check gh
if command -v gh &> /dev/null; then
    GH_VERSION=$(gh --version | head -1)
    echo -e "${GREEN}✓${NC} gh: ${GH_VERSION}"
else
    echo -e "${RED}✗${NC} gh CLI: not found"
    echo -e "${YELLOW}Install: winget install GitHub.cli${NC} (Windows) or brew install gh (macOS)"
    exit 1
fi

# Check auth
echo ""
echo "Checking GitHub authentication..."
if gh auth status 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Authenticated on GitHub"
else
    echo -e "${YELLOW}!${NC} Not authenticated on GitHub"
    echo ""
    echo "Run: gh auth login"
    exit 1
fi

echo ""
echo -e "${GREEN}All dependencies ready!${NC}"
exit 0
