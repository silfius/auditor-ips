#!/usr/bin/env bash

/usr/bin/clear 2>/dev/null || true

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)"
if [ -d "$SCRIPT_DIR/app" ] && [ -f "$SCRIPT_DIR/scripts/install_auditor.py" ]; then
    REPO_DIR="$SCRIPT_DIR"
    PY_INSTALLER="$SCRIPT_DIR/scripts/install_auditor.py"
elif [ -d "$SCRIPT_DIR/../../app" ] && [ -f "$SCRIPT_DIR/install_auditor.py" ]; then
    REPO_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../.." 2>/dev/null && pwd)"
    PY_INSTALLER="$SCRIPT_DIR/install_auditor.py"
else
    REPO_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." 2>/dev/null && pwd)"
    PY_INSTALLER="$SCRIPT_DIR/scripts/install_auditor.py"
fi
ASSUME_YES=0
ALLOW_INSTALL_DEPS=0
INSTALL_ACTION="install"
SYSTEM_INSTALL=0
PASSTHROUGH=()

log() {
    printf '%s\n' "$*"
}

warn() {
    printf 'ADVERTENCIA: %s\n' "$*" >&2
}

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    return 1
}

ask_yes_no() {
    local prompt="$1"
    local default_yes="${2:-0}"
    local answer=""

    if [ "$ASSUME_YES" -eq 1 ]; then
        [ "$default_yes" -eq 1 ]
        return $?
    fi

    if [ "$default_yes" -eq 1 ]; then
        printf '%s [S/n]: ' "$prompt"
    else
        printf '%s [s/N]: ' "$prompt"
    fi
    IFS= read -r answer
    answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
    if [ -z "$answer" ]; then
        [ "$default_yes" -eq 1 ]
        return $?
    fi
    case "$answer" in
        s|si|sí|y|yes) return 0 ;;
        *) return 1 ;;
    esac
}

usage() {
    cat <<'USAGE'
Auditor IPs — asistente de instalación

Uso:
  ./install.sh [acción] [opciones del instalador]

Acciones:
  --check        Comprueba host, dependencias, Docker, red y almacenamiento.
  --diagnose     Genera un paquete de diagnóstico sin secretos.
  --upgrade      Actualiza una instalación existente con backup y rollback.
  --rollback     Restaura el último backup de upgrade.
  --uninstall    Desinstala con opciones para conservar o eliminar datos.

Opciones bootstrap:
  --install-deps Autoriza instalación automática de dependencias ausentes.
  --yes          Usa respuestas seguras por defecto.
  --help         Muestra esta ayuda.

El resto de argumentos se envía a scripts/install_auditor.py.
USAGE
}

main() {
for arg in "$@"; do
    case "$arg" in
        --check)
            INSTALL_ACTION="check"
            ;;
        --diagnose)
            INSTALL_ACTION="diagnose"
            ;;
        --upgrade)
            INSTALL_ACTION="upgrade"
            ;;
        --rollback)
            INSTALL_ACTION="rollback"
            ;;
        --uninstall)
            INSTALL_ACTION="uninstall"
            ;;
        --install-deps)
            ALLOW_INSTALL_DEPS=1
            ;;
        --system-install)
            SYSTEM_INSTALL=1
            PASSTHROUGH+=("--system-install")
            ;;
        --yes)
            ASSUME_YES=1
            PASSTHROUGH+=("--yes")
            ;;
        --help|-h)
            usage
            if [ -x "$PY_INSTALLER" ] || [ -f "$PY_INSTALLER" ]; then
                printf '\nOpciones avanzadas del instalador Python:\n\n'
                python3 "$PY_INSTALLER" --help 2>/dev/null || true
            fi
            return 0 2>/dev/null || true
            ;;
        *)
            PASSTHROUGH+=("$arg")
            ;;
    esac
done

if [ "$(uname -s 2>/dev/null)" != "Linux" ]; then
    fail "El instalador del servidor solo soporta Linux."
    return 1 2>/dev/null || true
fi

if [ ! -f /etc/os-release ]; then
    fail "No se puede identificar la distribución: falta /etc/os-release."
    return 1 2>/dev/null || true
fi

# shellcheck disable=SC1091
. /etc/os-release
DISTRO_ID="${ID:-unknown}"
DISTRO_LIKE="${ID_LIKE:-}"
DISTRO_CODENAME="${VERSION_CODENAME:-}"
ARCH="$(uname -m 2>/dev/null)"

case "$ARCH" in
    x86_64|amd64|aarch64|arm64) ;;
    *)
        fail "Arquitectura no certificada: $ARCH. Soportadas inicialmente: x86_64 y arm64."
        return 1 2>/dev/null || true
        ;;
esac

is_debian_family=0
is_arch_family=0
case " $DISTRO_ID $DISTRO_LIKE " in
    *debian*|*ubuntu*|*linuxmint*) is_debian_family=1 ;;
esac
case " $DISTRO_ID $DISTRO_LIKE " in
    *arch*|*manjaro*) is_arch_family=1 ;;
esac

command_ok() {
    command -v "$1" >/dev/null 2>&1
}

compose_ok() {
    command_ok docker && docker compose version >/dev/null 2>&1
}

docker_daemon_ok() {
    command_ok docker && docker info >/dev/null 2>&1
}

sudo_docker_ok() {
    command_ok sudo && sudo -n docker info >/dev/null 2>&1
}

missing=()
command_ok git || missing+=("git")
command_ok python3 || missing+=("python3")
command_ok curl || missing+=("curl")
command_ok openssl || missing+=("openssl")
command_ok ip || missing+=("iproute2")
command_ok tar || missing+=("tar")
command_ok docker || missing+=("docker")
compose_ok || missing+=("docker-compose-plugin")

install_debian_base() {
    sudo apt-get update || return 1
    sudo apt-get install -y git python3 curl ca-certificates openssl iproute2 tar || return 1
    return 0
}

apt_package_available() {
    command_ok apt-cache && apt-cache show "$1" >/dev/null 2>&1
}

installed_conflicting_docker_packages() {
    command_ok dpkg-query || return 0
    for package in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
        dpkg-query -W -f='${Status}' "$package" 2>/dev/null           | grep -q 'install ok installed'           && printf '%s\n' "$package"
    done
}

remove_conflicting_docker_packages() {
    local conflicts=()
    while IFS= read -r package; do
        [ -n "$package" ] && conflicts+=("$package")
    done < <(installed_conflicting_docker_packages)

    if [ "${#conflicts[@]}" -eq 0 ]; then
        return 0
    fi

    log ""
    log "Paquetes Docker incompatibles con el repositorio oficial detectados:"
    printf '  - %s\n' "${conflicts[@]}"
    log "Los datos existentes bajo /var/lib/docker no se eliminan con esta operación."

    if ! ask_yes_no "¿Autorizar la retirada de estos paquetes antes de instalar Docker oficial?" 0; then
        fail "No se modificarán paquetes Docker existentes."
        return 1
    fi

    sudo apt-get remove -y "${conflicts[@]}" || return 1
}

install_compose_for_existing_docker_debian() {
    local package=""
    for candidate in docker-compose-v2 docker-compose-plugin; do
        if apt_package_available "$candidate"; then
            package="$candidate"
            break
        fi
    done
    [ -n "$package" ] || return 1
    log "Instalando ${package} para el Docker existente..."
    sudo apt-get install -y "$package"
}

install_docker_debian_official() {
    local upstream="$DISTRO_ID"
    local codename="$DISTRO_CODENAME"

    case "$upstream" in
        linuxmint|pop|elementary|zorin) upstream="ubuntu" ;;
    esac
    if [ "$upstream" != "ubuntu" ] && [ "$upstream" != "debian" ]; then
        if printf ' %s ' "$DISTRO_LIKE" | grep -q ubuntu; then
            upstream="ubuntu"
        elif printf ' %s ' "$DISTRO_LIKE" | grep -q debian; then
            upstream="debian"
        else
            fail "No se puede seleccionar con seguridad el repositorio Docker para $DISTRO_ID."
            return 1
        fi
    fi

    if [ "$upstream" = "ubuntu" ] && [ "$DISTRO_ID" != "ubuntu" ] && [ -n "${UBUNTU_CODENAME:-}" ]; then
        codename="$UBUNTU_CODENAME"
    fi
    if [ -z "$codename" ]; then
        codename="$(. /etc/os-release && printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")"
    fi
    if [ -z "$codename" ]; then
        fail "No se ha podido determinar el codename de la distribución."
        return 1
    fi

    sudo install -m 0755 -d /etc/apt/keyrings || return 1
    curl -fsSL "https://download.docker.com/linux/${upstream}/gpg" \
      | sudo tee /etc/apt/keyrings/docker.asc >/dev/null || return 1
    sudo chmod a+r /etc/apt/keyrings/docker.asc || return 1

    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
      "$(dpkg --print-architecture)" "$upstream" "$codename" \
      | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null || return 1

    sudo apt-get update || return 1
    sudo apt-get install -y \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || return 1
    return 0
}

install_arch_dependencies() {
    sudo pacman -Sy --needed --noconfirm \
      git python curl ca-certificates openssl iproute2 tar docker docker-compose || return 1
    return 0
}

if [ "${#missing[@]}" -gt 0 ]; then
    log ""
    log "Faltan componentes necesarios:"
    for item in "${missing[@]}"; do
        log "  - $item"
    done
    log ""
    log "El asistente puede instalarlos. Mostrará y ejecutará paquetes del sistema mediante sudo."
    log "No guarda ni procesa la contraseña de sudo."

    if [ "$ALLOW_INSTALL_DEPS" -ne 1 ]; then
        if [ "$INSTALL_ACTION" = "check" ] || [ "$INSTALL_ACTION" = "diagnose" ]; then
            fail "Comprobación completada con dependencias ausentes. No se ha modificado el sistema."
            return 1
        fi
        if [ "$ASSUME_YES" -eq 1 ]; then
            fail "En modo --yes debes añadir --install-deps para autorizar paquetes del sistema."
            return 1
        fi
        if ask_yes_no "¿Autorizar la instalación de las dependencias ausentes?" 1; then
            ALLOW_INSTALL_DEPS=1
        fi
    fi

    if [ "$ALLOW_INSTALL_DEPS" -ne 1 ]; then
        fail "Dependencias ausentes. Vuelve a ejecutar con --install-deps o instálalas manualmente."
        return 1
    fi

    if ! command_ok sudo; then
        fail "Se necesita sudo para instalar paquetes del sistema."
        return 1 2>/dev/null || true
    fi

    log ""
    log "Solicitando autorización sudo..."
    sudo -v || {
        fail "No se obtuvo autorización sudo."
        return 1 2>/dev/null || true
    }

    if [ "$is_debian_family" -eq 1 ]; then
        install_debian_base || {
            fail "No se pudieron instalar las dependencias base."
            return 1 2>/dev/null || true
        }
        if ! command_ok docker; then
            remove_conflicting_docker_packages || return 1
            log "Instalando Docker Engine y Docker Compose desde el repositorio oficial de Docker..."
            install_docker_debian_official || {
                fail "No se pudo instalar Docker Engine/Compose."
                return 1 2>/dev/null || true
            }
        elif ! compose_ok; then
            if ! install_compose_for_existing_docker_debian; then
                warn "Docker existe, pero la distribución no ofrece un plugin Compose compatible."
                log "La alternativa es migrar Docker al repositorio oficial. Puede retirar paquetes incompatibles, pero conserva /var/lib/docker."
                if ! ask_yes_no "¿Autorizar la migración de paquetes Docker al repositorio oficial?" 0; then
                    fail "Docker Compose V2 sigue ausente. No se ha reemplazado Docker."
                    return 1
                fi
                remove_conflicting_docker_packages || return 1
                install_docker_debian_official || {
                    fail "No se pudo completar la migración a Docker oficial."
                    return 1 2>/dev/null || true
                }
            fi
        fi
    elif [ "$is_arch_family" -eq 1 ]; then
        install_arch_dependencies || {
            fail "No se pudieron instalar las dependencias en Arch/Manjaro."
            return 1 2>/dev/null || true
        }
    else
        fail "Distribución no soportada para instalación automática: $DISTRO_ID."
        log "Instala manualmente: git, python3, curl, openssl, iproute2, tar, Docker Engine y Docker Compose V2."
        return 1 2>/dev/null || true
    fi
fi

if command_ok systemctl && command_ok docker; then
    if ! systemctl is-active --quiet docker 2>/dev/null; then
        log "Docker está instalado, pero el servicio no está activo."
        if ask_yes_no "¿Autorizar sudo systemctl enable --now docker?" 1; then
            sudo systemctl enable --now docker || {
                fail "No se pudo iniciar Docker."
                return 1 2>/dev/null || true
            }
        fi
    fi
fi

if docker_daemon_ok; then
    export AUDITOR_DOCKER_USE_SUDO=0
elif command_ok sudo && sudo docker info >/dev/null 2>&1; then
    export AUDITOR_DOCKER_USE_SUDO=1
    warn "El usuario actual no tiene acceso directo a Docker. El asistente usará sudo para Docker."
    if getent group docker >/dev/null 2>&1 && ! id -nG | tr ' ' '\n' | grep -qx docker; then
        log "Puedes evitar sudo en futuras sesiones añadiendo tu usuario al grupo docker."
        if ask_yes_no "¿Añadir $USER al grupo docker? Requerirá cerrar y abrir sesión después" 0; then
            sudo usermod -aG docker "$USER" || warn "No se pudo modificar el grupo docker."
        fi
    fi
else
    fail "Docker está instalado, pero no se puede acceder al daemon ni con el usuario actual ni mediante sudo."
    return 1 2>/dev/null || true
fi

if [ ! -f "$PY_INSTALLER" ]; then
    fail "No existe el instalador Python esperado: $PY_INSTALLER"
    return 1 2>/dev/null || true
fi

cd "$REPO_DIR" || {
    fail "No se pudo entrar en $REPO_DIR"
    return 1 2>/dev/null || true
}

run_python_installer() {
    if [ "$SYSTEM_INSTALL" -eq 1 ] && [ "$(id -u)" -ne 0 ]; then
        sudo -E python3 "$PY_INSTALLER" "$@"
    else
        python3 "$PY_INSTALLER" "$@"
    fi
}

case "$INSTALL_ACTION" in
    check)
        run_python_installer --check-only "${PASSTHROUGH[@]}"
        ;;
    diagnose)
        run_python_installer --diagnose "${PASSTHROUGH[@]}"
        ;;
    upgrade)
        run_python_installer --upgrade "${PASSTHROUGH[@]}"
        ;;
    rollback)
        run_python_installer --rollback "${PASSTHROUGH[@]}"
        ;;
    uninstall)
        run_python_installer --uninstall "${PASSTHROUGH[@]}"
        ;;
    *)
        run_python_installer "${PASSTHROUGH[@]}"
        ;;
esac
}

main "$@"
