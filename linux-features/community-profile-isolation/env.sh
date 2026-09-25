# Community package hard isolation.
# This hook is sourced with `set -a` by the packaged launcher.
: "${HOME:?HOME is required}"
CODEX_HOME="$HOME/.codex-community"

# Keep bare `codex` invocations launched by ChatGPT Community inside the
# Community distribution. This PATH change is process-local: the user's global
# shell still resolves `codex` to the Official installation.
CODEX_COMMUNITY_BIN_DIR="$CODEX_LINUX_APP_DIR/resources"
case ":${PATH:-}:" in
  ":$CODEX_COMMUNITY_BIN_DIR:"*) ;;
  *)
    PATH="$CODEX_COMMUNITY_BIN_DIR${PATH:+:$PATH}"
    export PATH
    ;;
esac
unset CODEX_COMMUNITY_BIN_DIR
