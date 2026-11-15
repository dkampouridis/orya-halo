# Source this in Git Bash on Windows to put the Rust toolchain and gcc on PATH:
#   source scripts/env.sh
# Linux and macOS shells normally have both already and can skip it.
export PATH="$HOME/.cargo/bin:$PATH"
if [ -n "$LOCALAPPDATA" ]; then
  for d in "$LOCALAPPDATA"/Microsoft/WinGet/Packages/BrechtSanders.WinLibs*/mingw64/bin; do
    [ -d "$d" ] && export PATH="$d:$PATH"
  done
fi
