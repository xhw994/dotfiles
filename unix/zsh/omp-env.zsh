# Layer the personal overlay over Gohan's managed config. PI_CONFIG_FILES is
# strict (a missing file aborts omp), so add it only when the file resolves.
if [ -f "$HOME/.omp/agent/personal.yml" ]; then
  case ":${PI_CONFIG_FILES:-}:" in
    *":$HOME/.omp/agent/personal.yml:"*) ;;
    *) export PI_CONFIG_FILES="${PI_CONFIG_FILES:+$PI_CONFIG_FILES:}$HOME/.omp/agent/personal.yml" ;;
  esac
fi
