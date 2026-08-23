#!/usr/bin/env bash
#
# Gets Morning Brief building on a Mac.
#
#   ./ios/setup-mac.sh              # check the toolchain, then open Xcode
#   ./ios/setup-mac.sh --build      # also compile for the simulator (no signing needed)
#   ./ios/setup-mac.sh --team ABC123456   # write your signing team into the project
#   ./ios/setup-mac.sh --build --no-open  # CI-style: verify it compiles, open nothing
#
# The --build check is the useful one: it compiles for the simulator, which needs
# no Apple account and no signing, so it tells you whether the code is sound
# before you get into provisioning.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$SCRIPT_DIR/MorningBrief/MorningBrief.xcodeproj"
SCHEME="MorningBrief"
MIN_XCODE_MAJOR=16

DO_BUILD=0
DO_OPEN=1
TEAM=""

while [ $# -gt 0 ]; do
  case "$1" in
    --build)    DO_BUILD=1 ;;
    --no-open)  DO_OPEN=0 ;;
    --team)     TEAM="${2:-}"; shift ;;
    -h|--help)  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '    \033[33mwarn\033[0m %s\n' "$*"; }
die()  { printf '    \033[31mfail\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- environment

say "Checking the environment"

[ "$(uname -s)" = "Darwin" ] || die "This script only runs on macOS (found $(uname -s))."
ok "macOS $(sw_vers -productVersion)"

# The Command Line Tools ship their own /usr/bin/xcodebuild shim, so the presence
# of that binary proves nothing. Find a real Xcode.app before recommending a path
# to point xcode-select at - otherwise the advice is a directory that may not exist.
XCODE_APP=""
for candidate in /Applications/Xcode.app /Applications/Xcode-beta.app "$HOME/Applications/Xcode.app"; do
  if [ -d "$candidate/Contents/Developer" ]; then XCODE_APP="$candidate"; break; fi
done
if [ -z "$XCODE_APP" ] && command -v mdfind >/dev/null 2>&1; then
  XCODE_APP="$(mdfind "kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'" 2>/dev/null | head -n 1 || true)"
  [ -n "$XCODE_APP" ] && [ ! -d "$XCODE_APP/Contents/Developer" ] && XCODE_APP=""
fi

if [ -z "$XCODE_APP" ]; then
  warn "Xcode itself is not installed - only Apple's Command Line Tools."
  echo
  echo "    The Command Line Tools provide a /usr/bin/xcodebuild shim, which is why"
  echo "    'xcodebuild' appears to exist. It cannot build an iOS app."
  echo
  echo "    Install Xcode from the App Store (a ~10GB download):"
  echo "      open 'macappstores://apps.apple.com/app/xcode/id497799835'"
  echo
  echo "    Then launch it once to finish setup, and re-run this script."
  echo
  die "Xcode is required to build the app."
fi
ok "Xcode found at $XCODE_APP"

DEVELOPER_DIR_PATH="$(xcode-select -p 2>/dev/null || true)"
case "$DEVELOPER_DIR_PATH" in
  "$XCODE_APP"/*) ok "developer dir: $DEVELOPER_DIR_PATH" ;;
  *)
    warn "xcode-select points at ${DEVELOPER_DIR_PATH:-nothing}, not at Xcode."
    echo
    echo "    Fix it with:"
    echo "      sudo xcode-select -s '$XCODE_APP/Contents/Developer'"
    echo
    die "Re-run this script afterwards."
    ;;
esac

# `xcodebuild -version` fails until the licence is accepted, so surface that clearly.
if ! XCODE_VERSION_RAW="$(xcodebuild -version 2>/dev/null)"; then
  warn "Xcode will not report its version - its licence is probably unaccepted."
  echo
  echo "    Run these two, then re-run this script:"
  echo "      sudo xcodebuild -license accept"
  echo "      sudo xcodebuild -runFirstLaunch"
  echo
  die "Xcode needs its one-time first-launch setup."
fi

XCODE_VERSION="$(printf '%s' "$XCODE_VERSION_RAW" | awk 'NR==1{print $2}')"
XCODE_MAJOR="${XCODE_VERSION%%.*}"
ok "Xcode $XCODE_VERSION"

if [ "${XCODE_MAJOR:-0}" -lt "$MIN_XCODE_MAJOR" ]; then
  warn "This project uses the Xcode ${MIN_XCODE_MAJOR} project format (objectVersion 77)."
  echo
  echo "    Either update Xcode, or regenerate the project for your version:"
  echo "      brew install xcodegen"
  echo "      cd '$SCRIPT_DIR/MorningBrief' && xcodegen generate"
  echo
  die "Xcode $XCODE_VERSION is too old to open this project file."
fi

[ -d "$PROJECT" ] || die "Project not found at $PROJECT"
ok "project: $PROJECT"

# ------------------------------------------------------------------ signing

say "Checking code signing"

AVAILABLE_TEAMS="$(security find-identity -v -p codesigning 2>/dev/null \
  | sed -n 's/.*"Apple Develop[^:]*: .*(\([A-Z0-9]\{10\}\))".*/\1/p' \
  | sort -u || true)"

if [ -n "$TEAM" ]; then
  case "$TEAM" in
    [A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]) ;;
    *) die "--team expects a 10-character Apple team ID, got '$TEAM'." ;;
  esac

  say "Writing DEVELOPMENT_TEAM=$TEAM into the project"
  cp "$PROJECT/project.pbxproj" "$PROJECT/project.pbxproj.bak"

  # Drop any team we wrote previously, then insert once per app-target config.
  # Without the delete pass, a second --team run duplicates the key and Xcode
  # refuses to open the project.
  /usr/bin/perl -0pi -e 's/^\t*DEVELOPMENT_TEAM = [^;]*;\n//mg' "$PROJECT/project.pbxproj"
  /usr/bin/perl -0pi -e "s/(PRODUCT_BUNDLE_IDENTIFIER = com\.philkellner\.MorningBrief;)/DEVELOPMENT_TEAM = $TEAM;\n\t\t\t\t\$1/g" \
    "$PROJECT/project.pbxproj"

  WRITTEN="$(grep -c 'DEVELOPMENT_TEAM' "$PROJECT/project.pbxproj" || true)"
  if [ "$WRITTEN" != "2" ]; then
    mv "$PROJECT/project.pbxproj.bak" "$PROJECT/project.pbxproj"
    die "Expected to write 2 team entries but wrote $WRITTEN - project restored, set the team in Xcode instead."
  fi
  rm -f "$PROJECT/project.pbxproj.bak"
  ok "team written to both build configurations"
elif [ -n "$AVAILABLE_TEAMS" ]; then
  ok "signing identities found:"
  printf '         %s\n' $AVAILABLE_TEAMS
  echo "         Re-run with --team <ID> to write one in, or just pick it in Xcode's"
  echo "         Signing & Capabilities tab."
else
  warn "No code-signing identity yet."
  echo "         That is fine for a simulator build. To run on your iPhone:"
  echo "         Xcode → Settings → Accounts → add your Apple ID, then pick the team"
  echo "         under the target's Signing & Capabilities tab."
fi

# -------------------------------------------------------------------- build

if [ "$DO_BUILD" -eq 1 ]; then
  say "Compiling for the simulator (no signing required)"
  echo "    This is the real test - the Swift was written on Linux and never compiled."
  echo

  LOG="$(mktemp -t morningbrief-build)"
  if xcodebuild \
      -project "$PROJECT" \
      -scheme "$SCHEME" \
      -sdk iphonesimulator \
      -destination 'generic/platform=iOS Simulator' \
      -configuration Debug \
      CODE_SIGNING_ALLOWED=NO \
      build > "$LOG" 2>&1; then
    ok "the app compiles"
    rm -f "$LOG"
  else
    warn "compile failed - the errors are below"
    echo
    grep -E '(error|warning):' "$LOG" | sed 's/^/    /' | head -40 || tail -40 "$LOG" | sed 's/^/    /'
    echo
    echo "    Full log: $LOG"
    echo "    Paste the errors back to Claude and they can be fixed."
    exit 1
  fi
fi

# --------------------------------------------------------------------- open

if [ "$DO_OPEN" -eq 1 ]; then
  say "Opening Xcode"
  open "$PROJECT"
  cat <<'NEXT'

    Next, in Xcode:
      1. Select the MorningBrief target → Signing & Capabilities → pick your Team.
      2. Choose your iPhone from the device menu at the top.
      3. Press Run (Cmd-R).
      4. Allow notifications when the app asks.
      5. Settings (gear icon) → "Send a test notification" to confirm delivery.

    A free Apple ID works, but Apple expires free provisioning after 7 days,
    so you would re-run from Xcode weekly. A paid account lasts a year.

NEXT
fi

say "Done"
